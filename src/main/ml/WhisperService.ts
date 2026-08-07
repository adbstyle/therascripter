import { existsSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { cpus } from 'os'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type {
  DiarizationData,
  StitchMap,
  TranscriptData,
  TranscriptWord,
  TranscriptSegment
} from '../../shared/types'
import type { TaskExecutor, ExecutorRuntime } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase } from '../db/connection'
import { runSubprocess } from '../utils/subprocess'
import { getSettings } from '../services/SettingsService'
import { getActiveModelPath } from '../services/ModelDownloadService'
import { writeFileAtomic } from '../utils/file-ops'
import { removeFillerWords, rebuildSegments } from './filler-removal'
import { filterSpecialTokens, mergeSubTokens } from './token-processing'
import type { WhisperToken } from './token-processing'
import { stitchSpeechSegments } from '../services/AudioStitchService'
import type { StitchedAudio } from '../services/AudioStitchService'
import { remapStitchedTimestamp } from './timestamp-remap'

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
      return join(process.resourcesPath, 'whisper', 'bin', 'whisper-cli')
    }
    return join(app.getAppPath(), 'resources', 'whisper', 'bin', 'whisper-cli')
  }

  private getModelPath(): string {
    const path = getActiveModelPath('asr')
    if (path === null) {
      throw new Error(
        'Kein aktives Transkriptions-Modell — bitte ein Modell unter Einstellungen → Modelle aktivieren.'
      )
    }
    return path
  }

  async execute(
    task: Task,
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    runtime?: ExecutorRuntime
  ): Promise<void> {
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
    if (!session.diarizationPath) {
      throw new Error(
        `Session ${task.sessionId} hat keinen Diarization-Pfad — Pipeline-Reihenfolge falsch?`
      )
    }
    if (!existsSync(session.diarizationPath)) {
      throw new Error(`Diarization-Datei nicht gefunden: ${session.diarizationPath}`)
    }

    // Load diarization output (ADR-007: Pyannote runs first, Whisper consumes its output)
    const diarization = JSON.parse(
      readFileSync(session.diarizationPath, 'utf-8')
    ) as DiarizationData

    // Estimate original audio duration from WAV header (same heuristic as PyannoteSidecar)
    const audioStats = statSync(session.audioPath)
    const WAV_HEADER_SIZE = 44
    const audioDurationEstimate =
      Math.max(0, audioStats.size - WAV_HEADER_SIZE) / (48000 * 2) // 48kHz 16-bit mono

    // Empty-speech short-circuit: if Pyannote found no speech, skip the whole
    // stitch+whisper round-trip and write an empty transcript. AlignmentService
    // and AnonymizationService handle empty input gracefully so the pipeline
    // reaches 'review' status (Erfolgskriterium #2).
    if (diarization.speakers.length === 0) {
      console.log(
        `[WhisperService] Pyannote reported no speech for session ${task.sessionId} — ` +
          `skipping stitch+whisper, writing empty transcript`
      )
      const emptyTranscript: TranscriptData = {
        words: [],
        segments: [],
        metadata: {
          model: 'whisper-cli',
          language: 'de',
          duration: audioDurationEstimate
        }
      }
      const transcriptPath = sessionService.generateTranscriptPath(task.sessionId)
      writeFileAtomic(transcriptPath, JSON.stringify(emptyTranscript, null, 2))
      sessionService.updateSession(task.sessionId, { transcriptPath })
      onProgress(1)
      return
    }

    // Important: declare stitched BEFORE the try so the finally block can clean
    // up even if stitchSpeechSegments throws after partial-write of the stitched
    // WAV (e.g. Stitch-Abbruch mid-copy). Initialize as undefined; assign inside
    // the try.
    let stitched: StitchedAudio | undefined

    try {
      stitched = await stitchSpeechSegments(
        session.audioPath,
        diarization.speakers,
        audioDurationEstimate,
        signal
      )

      // Calculate timeout based on the STITCHED duration (whisper input).
      // 4x as safety margin, min 60s.
      const stitchedDurationSec = stitched.stitchMap.stitchedDurationSec
      const timeoutMs = Math.max(stitchedDurationSec * 4 * 1000, 60_000)

      // Retune the watchdog to the stitched duration. The orchestrator
      // initially configured the threshold from the original audio length,
      // which is overly generous on sparse-speech inputs (e.g. 1h recording
      // → 5min speech). After stitching, the actual whisper input is the
      // 5min stream and 5%-progress events are spaced ~3s apart.
      runtime?.setAudioDurationSec(stitchedDurationSec)

      // Run whisper.cpp on the stitched WAV
      const whisperOutput = await this.runWhisper(
        binaryPath,
        modelPath,
        stitched.wavPath,
        timeoutMs,
        onProgress,
        signal
      )

      // Parse output, apply filler removal — operates in stitched timeline
      const stitchedTranscript = this.processOutput(whisperOutput)

      // Remap all timestamps back to original audio's wall-clock timeline
      const transcript = remapTranscript(
        stitchedTranscript,
        stitched.stitchMap,
        audioDurationEstimate
      )

      const transcriptPath = sessionService.generateTranscriptPath(task.sessionId)
      writeFileAtomic(transcriptPath, JSON.stringify(transcript, null, 2))
      sessionService.updateSession(task.sessionId, { transcriptPath })
    } finally {
      // Clean up stitched WAV (best-effort). `stitched` may still be undefined
      // if stitchSpeechSegments threw before assigning.
      try {
        if (stitched && existsSync(stitched.wavPath)) unlinkSync(stitched.wavPath)
      } catch {
        // intentionally swallowed — temp file cleanup
      }
    }
  }

  private async runWhisper(
    binaryPath: string,
    modelPath: string,
    audioPath: string,
    timeoutMs: number,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<WhisperJsonOutput> {
    // whisper.cpp writes JSON to {audioPath}.json when using -ojf
    const threadCount = Math.min(8, Math.max(1, cpus().length))
    const args = buildWhisperArgs(modelPath, audioPath, threadCount)
    const jsonPath = audioPath + '.json'

    let result
    try {
      // stdout is ignored — whisper.cpp writes JSON to file (-ojf), not
      // stdout. Piping stdout without reading it causes a deadlock when the
      // pipe buffer fills.
      result = await runSubprocess({
        bin: binaryPath,
        args,
        nice: 10, // QoS (NFR-23)
        timeoutMs,
        signal,
        stdout: 'ignore',
        onStderrLine: (line) => {
          const match = PROGRESS_REGEX.exec(line)
          if (match) {
            onProgress(parseInt(match[1], 10) / 100)
          }
        }
      })
    } catch (error) {
      throw new Error(
        `whisper-cli konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    // finally räumt die whisper-JSON (enthält das volle Transkript — PHI!)
    // auf ALLEN Pfaden weg: Erfolg, Timeout, Abort und Fehler. Vorher blieb
    // sie auf Timeout/Abort/Fehler liegen.
    try {
      if (result.aborted) {
        throw new Error('Verarbeitung reagiert nicht mehr')
      }
      if (result.timedOut) {
        throw new Error(`Transkription abgebrochen: Timeout nach ${Math.round(timeoutMs / 1000)}s`)
      }

      const stderrErrors = extractWhisperErrorLines(result.stderr)
      const stderrSummary =
        stderrErrors.length > 0 ? stderrErrors.join('; ') : result.stderr.slice(-500).trim()

      if (result.code !== 0) {
        throw new Error(
          `whisper-cli Fehler (Exit Code ${result.code}): ${stderrSummary || '(keine stderr-Ausgabe)'}`
        )
      }

      // whisper-cli exits 0 even when fatal argument errors are printed to
      // stderr (e.g. unknown flag → prints help → exits 0). Surface those
      // explicitly instead of letting the generic "no JSON output" path
      // mask the real cause.
      if (stderrErrors.length > 0) {
        throw new Error(
          `whisper-cli meldete einen Fehler trotz Exit-Code 0: ${stderrErrors.join('; ')}`
        )
      }

      if (!existsSync(jsonPath)) {
        throw new Error(
          `whisper-cli hat keine JSON-Ausgabe erzeugt${stderrSummary ? ` — stderr: ${stderrSummary}` : ''}`
        )
      }

      try {
        const jsonContent = readFileSync(jsonPath, 'utf-8')
        return JSON.parse(jsonContent) as WhisperJsonOutput
      } catch (error) {
        throw new Error(
          `JSON-Ausgabe konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } finally {
      try {
        unlinkSync(jsonPath)
      } catch {
        /* cleanup failure is non-fatal */
      }
    }
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

    // Belt-and-braces — getModelPath() above already throws if no model is
    // active, so this fallback is unreachable in practice but keeps the type
    // narrow.
    const activeAsrId = getSettings().get('activeModels').transcription ?? 'unknown'

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

/**
 * Remap a transcript whose word/segment timestamps live in the stitched-WAV's
 * timeline to the original audio's wall-clock timeline. The downstream
 * AlignmentService aligns words against pyannote's diarization which uses
 * original-audio timestamps, so this remap is required after the inversion
 * (ADR-007 / Issue #78).
 */
function remapTranscript(
  transcript: TranscriptData,
  map: StitchMap,
  originalDurationSec: number
): TranscriptData {
  const remappedWords: TranscriptWord[] = (transcript.words ?? []).map((w) => ({
    ...w,
    start: remapStitchedTimestamp(w.start, map),
    end: remapStitchedTimestamp(w.end, map)
  }))

  const remappedSegments: TranscriptSegment[] = (transcript.segments ?? []).map((s) => ({
    ...s,
    start: remapStitchedTimestamp(s.start, map),
    end: remapStitchedTimestamp(s.end, map)
  }))

  return {
    words: remappedWords,
    segments: remappedSegments,
    metadata: {
      ...transcript.metadata,
      duration: originalDurationSec, // wall-clock duration, not stitched
      stitchMap: map
    }
  }
}
