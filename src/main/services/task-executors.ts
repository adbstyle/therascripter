import type { Task, TaskType } from '../../shared/types'

export interface TaskExecutor {
  execute(
    task: Task,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class StubExecutor implements TaskExecutor {
  async execute(_task: Task, onProgress: (progress: number) => void, _signal?: AbortSignal): Promise<void> {
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
