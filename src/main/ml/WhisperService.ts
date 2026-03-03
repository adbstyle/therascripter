import { spawn } from 'child_process'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type { TranscriptData } from '../../shared/types'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { removeFillerWords, rebuildSegments } from './filler-removal'
import { filterSpecialTokens, mergeSubTokens } from './token-processing'
import type { WhisperToken } from './token-processing'

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

export class WhisperService implements TaskExecutor {
  private getBinaryPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'bin', 'whisper-cli')
    }
    return join(app.getAppPath(), 'resources', 'bin', 'whisper-cli')
  }

  private getModelPath(): string {
    return join(getDataDir(), 'models', 'asr', 'ggml-large-v3-turbo-q5_0.bin')
  }

  async execute(task: Task, onProgress: (progress: number) => void): Promise<void> {
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
      onProgress
    )

    // Parse output, apply filler removal, save transcript
    const transcript = this.processOutput(whisperOutput)

    const transcriptPath = sessionService.generateTranscriptPath(task.sessionId)
    writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2))

    sessionService.updateSession(task.sessionId, { transcriptPath })
  }

  private runWhisper(
    binaryPath: string,
    modelPath: string,
    audioPath: string,
    timeoutMs: number,
    onProgress: (progress: number) => void
  ): Promise<WhisperJsonOutput> {
    return new Promise((resolve, reject) => {
      // whisper.cpp writes JSON to {audioPath}.json when using -ojf
      const threadCount = Math.min(8, Math.max(1, cpus().length))
      const args = [
        '-m',
        modelPath,
        '-f',
        audioPath,
        '-l',
        'de',
        '-pp', // --print-progress
        '-ojf', // --output-json-full (includes word-level timestamps)
        '-t',
        String(threadCount)
      ]

      // QoS: nice -n 10 (NFR-23) — spawn via nice
      // stdout is ignored — whisper.cpp writes JSON to file (-ojf), not stdout.
      // Piping stdout without reading it causes a deadlock when the pipe buffer fills.
      const proc = spawn('nice', ['-n', '10', binaryPath, ...args], {
        stdio: ['ignore', 'ignore', 'pipe']
      })

      let stderr = ''
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(
          new Error(`Transkription abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
        )
      }, timeoutMs)

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
        reject(new Error(`whisper-cli konnte nicht gestartet werden: ${error.message}`))
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)

        if (code !== 0) {
          // Extract useful error from stderr
          const errorLines = stderr
            .split('\n')
            .filter(
              (line) => line.includes('error') || line.includes('Error') || line.includes('failed')
            )
          const errorDetail = errorLines.length > 0 ? errorLines.join('; ') : stderr.slice(-500)
          reject(new Error(`whisper-cli Fehler (Exit Code ${code}): ${errorDetail}`))
          return
        }

        // whisper.cpp writes output to {audioPath}.json
        const jsonPath = audioPath + '.json'
        if (!existsSync(jsonPath)) {
          reject(new Error('whisper-cli hat keine JSON-Ausgabe erzeugt'))
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

    return {
      words: cleanedWords,
      segments,
      metadata: {
        model: 'whisper-large-v3-turbo-q5_0',
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
