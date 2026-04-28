import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type { TranscriptData } from '../../shared/types'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { getSettings } from '../services/SettingsService'
import { getModelById } from '../services/ModelDownloadService'
import { writeFileAtomic } from '../utils/file-ops'
import { removeFillerWords, rebuildSegments } from './filler-removal'
import { filterSpecialTokens, mergeSubTokens } from './token-processing'
import type { WhisperToken } from './token-processing'
import { persistQualityResult } from './whisper-quality'

interface WhisperSegment {
  timestamps: { from: string; to: string }
  offsets: { from: number; to: number }
  text: string
  tokens: WhisperToken[]
}

interface WhisperJsonOutput {
  transcription: WhisperSegment[]
}

// Progress line format: "whisper_print_progress_callback: progress =  42%"
const PROGRESS_REGEX = /progress\s*=\s*(\d+)%/

// Exported for testing. Builds the whisper-cli argument list (sans the leading
// nice-wrapper). Centralised so unit tests can assert on the flag set and an
// integration test can verify the local whisper-cli still recognises every
// flag we pass.
export function buildWhisperArgs(
  modelPath: string,
  audioPath: string,
  threadCount: number
): string[] {
  return [
    '-m',
    modelPath,
    '-f',
    audioPath,
    '-l',
    'de',
    // ADR-006: prevents inter-window prompt-conditioning loops. Equivalent to
    // the (long-removed) --no-context / -nc flag but uses the supported
    // --max-context API. `0` means "carry no text context across 30 s
    // windows", i.e. each window starts fresh — exactly what we want.
    '-mc',
    '0',
    '-pp', // --print-progress
    '-ojf', // --output-json-full (includes word-level timestamps)
    '-t',
    String(threadCount)
  ]
}

// Pull `error: …` lines out of whisper-cli's stderr regardless of exit code.
// whisper-cli surfaces fatal argument errors (e.g. unknown flag) on stderr
// AND exits 0, which means the standard `code !== 0` branch can't be relied
// on alone — we need an independent stderr sniff to avoid silent failures.
function extractWhisperErrorLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^error:/i.test(line) || /\bunknown argument\b/i.test(line))
}

export class WhisperService implements TaskExecutor {
  private getBinaryPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'bin', 'whisper-cli')
    }
    return join(app.getAppPath(), 'resources', 'bin', 'whisper-cli')
  }

  private getModelPath(): string {
    const activeAsrId = getSettings().get('activeModels').transcription
    const def = getModelById(activeAsrId)
    if (!def) {
      throw new Error(
        `WhisperService: aktives ASR-Modell "${activeAsrId}" nicht im Katalog registriert.`
      )
    }
    return join(getDataDir(), 'models', def.relativePath)
  }

  async execute(task: Task, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    const binaryPath = this.getBinaryPath()
    const modelPath = this.getModelPath()

    if (!existsSync(binaryPath)) {
      throw new Error(
        `whisper-cli binary nicht gefunden: ${binaryPath}. Bitte führen Sie scripts/setup-whisper.sh aus.`
      )
    }

    if (!existsSync(modelPath)) {
      throw new Error(
        `Whisper-Modell nicht gefunden: ${modelPath}. Bitte laden Sie das Modell herunter.`
      )
    }

    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    if (!session?.audioPath) {
      throw new Error(`Session ${task.sessionId} hat keinen Audio-Pfad`)
    }

    if (!existsSync(session.audioPath)) {
      throw new Error(`Audiodatei nicht gefunden: ${session.audioPath}`)
    }

    // Calculate timeout: 4x audio duration as safety margin
    const audioStats = statSync(session.audioPath)
    const WAV_HEADER_SIZE = 44
    const audioDurationEstimate = Math.max(0, audioStats.size - WAV_HEADER_SIZE) / (48000 * 2) // 48kHz 16-bit mono
    const timeoutMs = Math.max(audioDurationEstimate * 4 * 1000, 60_000) // min 60s

    // Run whisper.cpp
    const whisperOutput = await this.runWhisper(
      binaryPath,
      modelPath,
      session.audioPath,
      timeoutMs,
      onProgress,
      signal
    )

    // Parse output, apply filler removal, save transcript
    const transcript = this.processOutput(whisperOutput)

    const transcriptPath = sessionService.generateTranscriptPath(task.sessionId)
    writeFileAtomic(transcriptPath, JSON.stringify(transcript, null, 2))

    // Quality check — detects whisper hallucination loops (ADR-006).
    // Non-blocking: classification is persisted as a flag but the pipeline
    // continues either way so the user sees the full result and can spot
    // the bad output / file a bug report.
    persistQualityResult(sessionService, task.sessionId, transcriptPath, transcript.segments)
  }

  private runWhisper(
    binaryPath: string,
    modelPath: string,
    audioPath: string,
    timeoutMs: number,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<WhisperJsonOutput> {
    return new Promise((resolve, reject) => {
      // whisper.cpp writes JSON to {audioPath}.json when using -ojf
      const threadCount = Math.min(8, Math.max(1, cpus().length))
      const args = buildWhisperArgs(modelPath, audioPath, threadCount)

      // QoS: nice -n 10 (NFR-23) — spawn via nice
      // stdout is ignored — whisper.cpp writes JSON to file (-ojf), not stdout.
      // Piping stdout without reading it causes a deadlock when the pipe buffer fills.
      const proc = spawn('nice', ['-n', '10', binaryPath, ...args], {
        stdio: ['ignore', 'ignore', 'pipe']
      })

      let stderr = ''
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        proc.kill('SIGTERM')
        settled = true
        reject(
          new Error(`Transkription abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
        )
      }, timeoutMs)

      // Watchdog abort: SIGTERM → 5s grace → SIGKILL
      const onAbort = (): void => {
        clearTimeout(timeout)
        proc.kill('SIGTERM')
        killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already dead */
          }
        }, 5_000)
        settled = true
        reject(new Error('Verarbeitung reagiert nicht mehr'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk

        // Parse progress from stderr
        const match = PROGRESS_REGEX.exec(chunk)
        if (match) {
          const pct = parseInt(match[1], 10)
          onProgress(pct / 100)
        }
      })

      proc.on('error', (error) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)
        if (!settled) {
          settled = true
          reject(new Error(`whisper-cli konnte nicht gestartet werden: ${error.message}`))
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', onAbort)

        if (settled) return

        const stderrErrors = extractWhisperErrorLines(stderr)
        const stderrSummary =
          stderrErrors.length > 0 ? stderrErrors.join('; ') : stderr.slice(-500).trim()

        if (code !== 0) {
          reject(
            new Error(
              `whisper-cli Fehler (Exit Code ${code}): ${stderrSummary || '(keine stderr-Ausgabe)'}`
            )
          )
          return
        }

        // whisper-cli exits 0 even when fatal argument errors are printed to
        // stderr (e.g. unknown flag → prints help → exits 0). Surface those
        // explicitly instead of letting the generic "no JSON output" path
        // mask the real cause.
        if (stderrErrors.length > 0) {
          reject(
            new Error(`whisper-cli meldete einen Fehler trotz Exit-Code 0: ${stderrErrors.join('; ')}`)
          )
          return
        }

        // whisper.cpp writes output to {audioPath}.json
        const jsonPath = audioPath + '.json'
        if (!existsSync(jsonPath)) {
          reject(
            new Error(
              `whisper-cli hat keine JSON-Ausgabe erzeugt${stderrSummary ? ` — stderr: ${stderrSummary}` : ''}`
            )
          )
          return
        }

        try {
          const jsonContent = readFileSync(jsonPath, 'utf-8')
          const output = JSON.parse(jsonContent) as WhisperJsonOutput

          resolve(output)

          // Clean up the temporary JSON file created by whisper.cpp (after resolve)
          try {
            unlinkSync(jsonPath)
          } catch {
            /* cleanup failure is non-fatal */
          }
        } catch (error) {
          reject(
            new Error(
              `JSON-Ausgabe konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        }
      })
    })
  }

  private processOutput(output: WhisperJsonOutput): TranscriptData {
    // Collect all tokens across segments
    const allTokens: WhisperToken[] = []
    for (const segment of output.transcription) {
      allTokens.push(...segment.tokens)
    }

    // Pipeline: filter specials → merge sub-tokens → remove fillers → rebuild segments
    const filtered = filterSpecialTokens(allTokens)
    const words = mergeSubTokens(filtered)
    const cleanedWords = removeFillerWords(words)
    const segments = rebuildSegments(cleanedWords)

    const duration = cleanedWords.length > 0 ? cleanedWords[cleanedWords.length - 1].end : 0

    const activeAsrId = getSettings().get('activeModels').transcription

    return {
      words: cleanedWords,
      segments,
      metadata: {
        model: activeAsrId,
        language: 'de',
        duration
      }
    }
  }
}

// Parse "HH:MM:SS,mmm" or "HH:MM:SS.mmm" to seconds
function parseTimestamp(ts: string): number {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(ts)
  if (!match) return 0

  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  const seconds = parseInt(match[3], 10)
  const millis = parseInt(match[4], 10)

  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

export { parseTimestamp }
