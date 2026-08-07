import type { TaskType } from '../../shared/types'

const POLL_INTERVAL_MS = 15_000

// Per-service stall thresholds (conservative, M1-based).
// Note: diarization and transcription use dynamic thresholds based on audio
// duration (computed in computeThreshold). See ADR-007 / Issue #78.
const STALL_THRESHOLDS: Partial<Record<TaskType, number>> = {
  anonymization: 120_000,
  ocr: 60_000,
  // pdf.js läuft in-process; onProgress feuert pro Seite. Eine einzelne
  // Seite, die >2 min hängt, ist pathologisch — Abort settlet den Executor
  // über abortable() (PDFExtractionExecutor), sonst wedged die Queue.
  extraction: 120_000,
  // LlamaSummarizer reports no fine-grained progress — onProgress is never called
  // during inference, so the watchdog only sees the initial heartbeat. Cold-start
  // of a 4B Q4_K_M GGUF on a loaded box can take ~30–60s; long anonymized inputs
  // push that further. Generous 10-min cap protects against runaway processes
  // without aborting healthy long-running inference.
  summarization: 600_000
}

// In-process executors — watchdog is a no-op for these.
// alignment ist rein synchroner CPU-Code (Millisekunden, keine Awaits):
// er kann weder hängen noch von einem Timeout unterbrochen werden — ein
// Watchdog wäre wirkungslos. extraction (pdf.js, async) wird seit dem
// abortable()-Umbau ÜBERWACHT (siehe STALL_THRESHOLDS).
const IN_PROCESS_TASKS: TaskType[] = ['alignment']

export interface WatchdogConfig {
  taskType: TaskType
  audioDurationSec?: number
  onStall: () => void
}

export class ProcessWatchdog {
  private lastHeartbeatAt = Date.now()
  private timer: ReturnType<typeof setInterval> | null = null
  private fired = false
  private stallThresholdMs: number
  private readonly taskType: TaskType
  private readonly onStall: () => void
  private readonly skip: boolean

  constructor(config: WatchdogConfig) {
    this.taskType = config.taskType
    this.onStall = config.onStall
    this.skip = IN_PROCESS_TASKS.includes(config.taskType)
    this.stallThresholdMs = this.computeThreshold(config.taskType, config.audioDurationSec)
  }

  start(): void {
    if (this.skip || this.timer !== null) return

    this.lastHeartbeatAt = Date.now()
    this.fired = false

    this.timer = setInterval(() => {
      this.check()
    }, POLL_INTERVAL_MS)
  }

  heartbeat(): void {
    this.lastHeartbeatAt = Date.now()
  }

  /**
   * Recompute the stall threshold from a new audio duration. Used by
   * WhisperService after stitching: the original audio duration is the
   * upper bound, but ASR runs on the (possibly much shorter) stitched WAV
   * — readjusting prevents 120s+ slack on tiny stitched payloads, where a
   * true stall would otherwise take longer to detect than necessary.
   */
  setAudioDurationSec(audioDurationSec: number): void {
    if (this.skip) return
    // Shrink or grow the threshold; both are safe because heartbeat resets
    // the elapsed-time counter on every progress event.
    this.stallThresholdMs = this.computeThreshold(this.taskType, audioDurationSec)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private check(): void {
    if (this.fired) return

    const elapsed = Date.now() - this.lastHeartbeatAt
    if (elapsed > this.stallThresholdMs) {
      this.fired = true
      console.log(
        `[Watchdog] Stall detected: no progress for ${Math.round(elapsed / 1000)}s` +
          ` (threshold: ${Math.round(this.stallThresholdMs / 1000)}s)`
      )
      this.onStall()
    }
  }

  private computeThreshold(taskType: TaskType, audioDurationSec?: number): number {
    if (taskType === 'transcription') {
      // Dynamic threshold: audioDuration / 40 gives the expected gap between
      // whisper.cpp 5%-step progress events. Minimum 120s.
      const dynamicSec = (audioDurationSec ?? 0) / 40
      return Math.max(dynamicSec, 120) * 1000
    }

    if (taskType === 'diarization') {
      // ADR-007 / Issue #78: pyannote runs first now and can take minutes per
      // stage with no progress event. Spike A datapoint: ~4 min on 62 min audio.
      // N=15 → 240s for 1h audio as safe reserve. Minimum 120s.
      const dynamicSec = (audioDurationSec ?? 0) / 15
      return Math.max(dynamicSec, 120) * 1000
    }

    return STALL_THRESHOLDS[taskType] ?? 120_000
  }
}
