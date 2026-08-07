import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type { DiarizationData, SpeakerSegment } from '../../shared/types'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { runSubprocess } from '../utils/subprocess'
import { getDatabase, getDataDir } from '../db/connection'
import { writeFileAtomic } from '../utils/file-ops'
import { resolvePythonSidecar } from './resolve-python'
import { getSettings } from '../services/SettingsService'

// Progress line format: "[PROGRESS] 42"
const PROGRESS_REGEX = /\[PROGRESS\]\s*(\d+)/

// Minimum segment duration in seconds. Segments shorter than this are
// filtered as pyannote segmentation noise. The Python-side collar merge
// (hardcoded at 0.5s in diarize.py) handles same-speaker gap filling.
const MIN_SEGMENT_DURATION_S = 0.5

export class PyannoteSidecar implements TaskExecutor {
  private getCommand(): { bin: string; args: string[] } {
    return resolvePythonSidecar('diarize.py')
  }

  private getModelDir(): string {
    return join(getDataDir(), 'models', 'diarization')
  }

  async execute(task: Task, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    const { bin, args: prefixArgs } = this.getCommand()

    if (!existsSync(bin)) {
      throw new Error(
        `Diarization-Binary nicht gefunden: ${bin}. Bitte prüfen Sie die Installation.`
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

    // Calculate timeout: 4x audio duration (pyannote is slower than whisper)
    const audioStats = statSync(session.audioPath)
    const WAV_HEADER_SIZE = 44
    const audioDurationEstimate = Math.max(0, audioStats.size - WAV_HEADER_SIZE) / (48000 * 2) // 48kHz 16-bit mono
    const timeoutMs = Math.max(audioDurationEstimate * 4 * 1000, 120_000) // min 2 minutes

    const activePipeline = getSettings().get('activeModels').diarizationPipeline

    // Run pyannote diarization
    const rttmOutput = await this.runPyannote(
      bin,
      prefixArgs,
      session.audioPath,
      activePipeline,
      timeoutMs,
      onProgress,
      signal
    )

    // Parse RTTM output
    const segments = parseRTTM(rttmOutput)

    // Build diarization data
    const diarization = buildDiarizationData(segments, audioDurationEstimate, activePipeline)

    // Save diarization results
    const diarizationPath = sessionService.generateDiarizationPath(task.sessionId)
    writeFileAtomic(diarizationPath, JSON.stringify(diarization))

    sessionService.updateSession(task.sessionId, { diarizationPath })
  }

  private async runPyannote(
    bin: string,
    prefixArgs: string[],
    audioPath: string,
    hfModel: string,
    timeoutMs: number,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const modelDir = this.getModelDir()
    const args = [
      ...prefixArgs,
      '--audio',
      audioPath,
      '--model-dir',
      modelDir,
      '--hf-model',
      hfModel,
      '--min-speakers',
      '1',
      '--max-speakers',
      '4'
    ]

    let result
    try {
      result = await runSubprocess({
        bin,
        args,
        nice: 10, // QoS (NFR-23)
        timeoutMs,
        signal,
        env: {
          // Prevent PyTorch from using all cores
          OMP_NUM_THREADS: '4',
          MKL_NUM_THREADS: '4',
          // Der Standalone-Sidecar shippt ohne __pycache__ (build-sidecar.sh
          // Prune-Step). Python darf die pyc-Caches nicht ins ad-hoc-signierte
          // App-Bundle nachschreiben — das würde das Resource-Seal brechen.
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
            ? `Diarization-Binary nicht ausführbar: ${bin}. Bitte prüfen Sie die Installation.`
            : `Python 3 nicht gefunden. Bitte installieren Sie Python 3.10+ oder führen Sie scripts/setup-pyannote.sh aus.`
        )
      }
      throw new Error(`Diarization konnte nicht gestartet werden: ${message}`)
    }

    if (result.aborted) {
      throw new Error('Verarbeitung reagiert nicht mehr')
    }
    if (result.timedOut) {
      throw new Error(`Diarization abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
    }
    if (result.code !== 0) {
      const errorLines = result.stderr
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('Error:') ||
            line.startsWith('Fehler:') ||
            line.includes('error') ||
            line.includes('Error') ||
            line.includes('failed') ||
            line.includes('fehlgeschlagen')
        )
      const errorDetail = errorLines.length > 0 ? errorLines.join('; ') : result.stderr.slice(-500)
      throw new Error(`Diarization Fehler (Exit Code ${result.code}): ${errorDetail}`)
    }

    return result.stdout
  }
}

// Exported for testing
export function parseRTTM(rttm: string): SpeakerSegment[] {
  const segments: SpeakerSegment[] = []

  for (const line of rttm.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('SPEAKER')) continue

    const parts = trimmed.split(/\s+/)
    // RTTM format: SPEAKER <file> <channel> <start> <duration> <NA> <NA> <label> <NA> <NA>
    if (parts.length < 8) continue

    const start = parseFloat(parts[3])
    const duration = parseFloat(parts[4])
    const label = parts[7]

    if (isNaN(start) || isNaN(duration)) continue

    segments.push({
      label,
      start,
      end: start + duration
    })
  }

  // Sort by start time
  segments.sort((a, b) => a.start - b.start)

  // Filter out very short segments — these are typically noise artifacts
  // from the segmentation model, not real speaker activity
  return segments.filter((seg) => seg.end - seg.start >= MIN_SEGMENT_DURATION_S)
}

// Exported for testing
export function buildDiarizationData(
  segments: SpeakerSegment[],
  duration: number,
  modelId: string
): DiarizationData {
  const uniqueSpeakers = new Set(segments.map((s) => s.label))

  return {
    speakers: segments,
    speakerCount: uniqueSpeakers.size,
    metadata: {
      model: modelId,
      duration
    }
  }
}
