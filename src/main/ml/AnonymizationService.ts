import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Task, TranscriptData } from '../../shared/types'
import type { NerServiceOutput } from '../../shared/types/NerTypes'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { runSubprocess } from '../utils/subprocess'
import { BlocklistRepository } from '../db/repositories/BlocklistRepository'
import { getDatabase, getDataDir } from '../db/connection'
import { runRegexEngine } from './regex-patterns'
import { mergeEntities } from './entity-merger'
import { resolveCoreferences } from './coreference-resolver'
import { buildEntityMap } from './entity-map-builder'
import { buildTipTapDocument } from './tiptap-builder'
import { countWords } from '../../shared/utils/countWords'
import { countPlaceholderChips } from '../../shared/utils/countPlaceholderChips'
import { resolvePythonSidecar } from './resolve-python'
import { writeFileAtomic } from '../utils/file-ops'

// Progress line format: "[PROGRESS] 42"
const PROGRESS_REGEX = /\[PROGRESS\]\s*(\d+)/

export class AnonymizationService implements TaskExecutor {
  private getCommand(): { bin: string; args: string[] } {
    return resolvePythonSidecar('ner_service.py')
  }

  private getModelDir(): string {
    return join(getDataDir(), 'models', 'ner')
  }

  async execute(
    task: Task,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    const transcriptSource = session?.alignedTranscriptPath ?? session?.transcriptPath
    if (!transcriptSource) {
      throw new Error(`Session ${task.sessionId} hat keinen Transkript-Pfad`)
    }
    if (!existsSync(transcriptSource)) {
      throw new Error(`Transkript nicht gefunden: ${transcriptSource}`)
    }

    onProgress(0.02)

    // 1. Load transcript (prefer aligned version with speaker labels)
    const transcript = JSON.parse(readFileSync(transcriptSource, 'utf-8')) as TranscriptData

    if (!transcript.segments || transcript.segments.length === 0) {
      // Audio-only graceful path (ADR-007 / Issue #78): empty transcripts from
      // recordings without speech reach 'review' with an empty editor.
      // For PDFs, an empty transcript indicates a failed extraction (corrupt/
      // unreadable file) — surface as 'error' so the user knows to re-import,
      // matching the pre-inversion behaviour.
      if (session?.type !== 'audio') {
        throw new Error('Transkript enthält keine Segmente für die Pseudonymisierung')
      }
      const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
      const anonymizedPath = sessionService.generateAnonymizedPath(task.sessionId)
      writeFileAtomic(anonymizedPath, JSON.stringify(emptyDoc))
      sessionService.updateSession(task.sessionId, {
        anonymizedPath,
        entityMap: {},
        wordCount: 0,
        anonymizationCount: 0
      })
      onProgress(1)
      return
    }

    onProgress(0.05)

    // 2. Run Python NER sidecar (0.05 → 0.50)
    const nerEntities = await this.runNerSidecar(
      transcriptSource,
      (nerProgress) => onProgress(0.05 + nerProgress * 0.45),
      signal
    )

    onProgress(0.5)

    // 3. Run regex engine
    const regexEntities = runRegexEngine(transcript.segments)

    onProgress(0.55)

    // 4. Load blocklist from DB
    const blocklistRepo = new BlocklistRepository(db)
    const blocklistEntries = blocklistRepo.findAll()

    onProgress(0.6)

    // 5. Merge entities (NER > Blocklist > Regex)
    const merged = mergeEntities(nerEntities, regexEntities, blocklistEntries, transcript.segments)

    onProgress(0.7)

    // 6. Resolve coreferences (PERSON entities)
    const resolved = resolveCoreferences(merged)

    onProgress(0.75)

    // 7. Build EntityMap
    const entityMap = buildEntityMap(resolved)

    onProgress(0.8)

    // 8. Determine speaker count for TipTap document
    const uniqueSpeakers = new Set(transcript.segments.map((s) => s.speaker).filter(Boolean))
    const speakerCount = uniqueSpeakers.size

    // 9. Build TipTap document
    const tiptapDoc = buildTipTapDocument(transcript.segments, entityMap, resolved, speakerCount)

    onProgress(0.9)

    // 10. Save results
    const anonymizedPath = sessionService.generateAnonymizedPath(task.sessionId)
    writeFileAtomic(anonymizedPath, JSON.stringify(tiptapDoc))

    const wordCount = countWords(tiptapDoc)
    const anonymizationCount = countPlaceholderChips(tiptapDoc)

    sessionService.updateSession(task.sessionId, {
      anonymizedPath,
      entityMap,
      wordCount,
      anonymizationCount
    })

    onProgress(1)
  }

  private async runNerSidecar(
    transcriptPath: string,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<NerServiceOutput['entities']> {
    const { bin, args: prefixArgs } = this.getCommand()

    if (!existsSync(bin)) {
      throw new Error(`NER-Binary nicht gefunden: ${bin}. Bitte prüfen Sie die Installation.`)
    }

    const modelDir = this.getModelDir()
    const args = [...prefixArgs, '--transcript', transcriptPath, '--model-dir', modelDir]

    // Timeout: 5 minutes should be plenty for NER (<30s typically)
    const timeoutMs = 300_000

    let result
    try {
      result = await runSubprocess({
        bin,
        args,
        nice: 10, // QoS (NFR-23)
        timeoutMs,
        signal,
        env: {
          OMP_NUM_THREADS: '4',
          MKL_NUM_THREADS: '4',
          // Kein pyc-Nachschreiben ins signierte Bundle — siehe PyannoteSidecar.
          PYTHONDONTWRITEBYTECODE: '1'
        },
        onStderrLine: (line) => {
          const match = PROGRESS_REGEX.exec(line)
          if (match) {
            onProgress(parseInt(match[1], 10) / 100)
          }
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ENOENT')) {
        throw new Error(
          app.isPackaged
            ? `NER-Binary nicht ausführbar: ${bin}. Bitte prüfen Sie die Installation.`
            : 'Python 3 nicht gefunden. Bitte installieren Sie Python 3.10+ oder führen Sie scripts/setup-ner.sh aus.'
        )
      }
      throw new Error(`NER konnte nicht gestartet werden: ${message}`)
    }

    if (result.aborted) {
      throw new Error('Verarbeitung reagiert nicht mehr')
    }
    if (result.timedOut) {
      throw new Error(`NER-Verarbeitung abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
    }
    if (result.code !== 0) {
      const errorLines = result.stderr
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('Fehler:') ||
            line.includes('Error') ||
            line.includes('error') ||
            line.includes('failed')
        )
      const errorDetail = errorLines.length > 0 ? errorLines.join('; ') : result.stderr.slice(-500)
      throw new Error(`NER Fehler (Exit Code ${result.code}): ${errorDetail}`)
    }

    try {
      const parsed = JSON.parse(result.stdout) as NerServiceOutput
      return parsed.entities
    } catch (parseError) {
      throw new Error(
        `NER-Ausgabe konnte nicht verarbeitet werden: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      )
    }
  }
}
