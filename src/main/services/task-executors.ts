import type { Task, TaskType } from '../../shared/types'

/**
 * Optional runtime helpers an executor can use to interact with the
 * orchestrating TaskQueueService. Currently only exposes the watchdog
 * threshold setter — used by WhisperService after stitching to retune
 * the stall budget for the (typically much shorter) stitched audio.
 */
export interface ExecutorRuntime {
  /**
   * Recompute the stall threshold based on a new audio duration. Safe to
   * call mid-execution; the watchdog reuses its existing heartbeat state.
   */
  setAudioDurationSec(audioDurationSec: number): void
}

export interface TaskExecutor {
  execute(
    task: Task,
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
    runtime?: ExecutorRuntime
  ): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class StubExecutor implements TaskExecutor {
  async execute(
    _task: Task,
    onProgress: (progress: number) => void,
    _signal?: AbortSignal,
    _runtime?: ExecutorRuntime
  ): Promise<void> {
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await delay(200)
      onProgress(i / steps)
    }
  }
}

export function createStubExecutors(): Map<TaskType, TaskExecutor> {
  const executors = new Map<TaskType, TaskExecutor>()
  const stub = new StubExecutor()
  executors.set('transcription', stub)
  executors.set('diarization', stub)
  executors.set('alignment', stub)
  executors.set('extraction', stub)
  executors.set('ocr', stub)
  executors.set('anonymization', stub)
  executors.set('summarization', stub)
  return executors
}
