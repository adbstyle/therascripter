import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Task, TranscriptData } from '../../shared/types'
import type { NerServiceOutput } from '../../shared/types/NerTypes'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { BlocklistRepository } from '../db/repositories/BlocklistRepository'
import { getDatabase, getDataDir } from '../db/connection'
import { runRegexEngine } from './regex-patterns'
import { mergeEntities } from './entity-merger'
import { resolveCoreferences } from './coreference-resolver'
import { buildEntityMap } from './entity-map-builder'
import { buildTipTapDocument } from './tiptap-builder'
import { resolvePythonSidecar } from './resolve-python'

// Progress line format: "[PROGRESS] 42"
const PROGRESS_REGEX = /\[PROGRESS\]\s*(\d+)/

export class AnonymizationService implements TaskExecutor {
  private getCommand(): { bin: string; args: string[] } {
    return resolvePythonSidecar('ner_service.py')
  }

  private getModelDir(): string {
    return join(getDataDir(), 'models', 'ner')
  }

  async execute(task: Task, onProgress: (progress: number) => void): Promise<void> {
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    if (!session?.transcriptPath) {
      throw new Error(`Session ${task.sessionId} hat keinen Transkript-Pfad`)
    }
    if (!existsSync(session.transcriptPath)) {
      throw new Error(`Transkript nicht gefunden: ${session.transcriptPath}`)
    }

    onProgress(0.02)

    // 1. Load transcript
    const transcript = JSON.parse(readFileSync(session.transcriptPath, 'utf-8')) as TranscriptData

    if (!transcript.segments || transcript.segments.length === 0) {
      throw new Error('Transkript enthält keine Segmente für die Anonymisierung')
    }

    onProgress(0.05)

    // 2. Run Python NER sidecar (0.05 → 0.50)
    const nerEntities = await this.runNerSidecar(session.transcriptPath, (nerProgress) =>
      onProgress(0.05 + nerProgress * 0.45)
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
    writeFileSync(anonymizedPath, JSON.stringify(tiptapDoc, null, 2))

    sessionService.updateSession(task.sessionId, {
      anonymizedPath,
      entityMap
    })

    onProgress(1)
  }

  private runNerSidecar(
    transcriptPath: string,
    onProgress: (progress: number) => void
  ): Promise<NerServiceOutput['entities']> {
    return new Promise((resolve, reject) => {
      const { bin, args: prefixArgs } = this.getCommand()

      if (!existsSync(bin)) {
        reject(new Error(`NER-Binary nicht gefunden: ${bin}. Bitte prüfen Sie die Installation.`))
        return
      }

      const modelDir = this.getModelDir()
      const args = [...prefixArgs, '--transcript', transcriptPath, '--model-dir', modelDir]

      // QoS: nice -n 10 (NFR-23)
      const proc = spawn('nice', ['-n', '10', bin, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OMP_NUM_THREADS: '4',
          MKL_NUM_THREADS: '4'
        }
      })

      let stdout = ''
      let stderr = ''

      // Timeout: 5 minutes should be plenty for NER (<30s typically)
      const timeoutMs = 300_000
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(
          new Error(`NER-Verarbeitung abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
        )
      }, timeoutMs)

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk

        const match = PROGRESS_REGEX.exec(chunk)
        if (match) {
          const pct = parseInt(match[1], 10)
          onProgress(pct / 100)
        }
      })

      proc.on('error', (error) => {
        clearTimeout(timeout)
        if (error.message.includes('ENOENT')) {
          const msg = app.isPackaged
            ? `NER-Binary nicht ausführbar: ${bin}. Bitte prüfen Sie die Installation.`
            : 'Python 3 nicht gefunden. Bitte installieren Sie Python 3.10+ oder führen Sie scripts/setup-ner.sh aus.'
          reject(new Error(msg))
        } else {
          reject(new Error(`NER konnte nicht gestartet werden: ${error.message}`))
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)

        if (code !== 0) {
          const errorLines = stderr
            .split('\n')
            .filter(
              (line) =>
                line.startsWith('Fehler:') ||
                line.includes('Error') ||
                line.includes('error') ||
                line.includes('failed')
            )
          const errorDetail = errorLines.length > 0 ? errorLines.join('; ') : stderr.slice(-500)
          reject(new Error(`NER Fehler (Exit Code ${code}): ${errorDetail}`))
          return
        }

        // Parse JSON output
        try {
          const result = JSON.parse(stdout) as NerServiceOutput
          resolve(result.entities)
        } catch (parseError) {
          reject(
            new Error(
              `NER-Ausgabe konnte nicht verarbeitet werden: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          )
        }
      })
    })
  }
}
