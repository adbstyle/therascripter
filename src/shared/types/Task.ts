export type TaskType =
  | 'transcription'
  | 'diarization'
  | 'alignment'
  | 'extraction'
  | 'ocr'
  | 'anonymization'
  | 'summarization'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  sessionId: string
  type: TaskType
  status: TaskStatus
  progress: number
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  /** Boot-Recovery-Zähler: wie oft dieser Task nach einem Crash auf pending zurückgesetzt wurde. */
  attempts: number
}

export interface CreateTaskInput {
  sessionId: string
  type: TaskType
}

export interface UpdateTaskInput {
  status?: TaskStatus
  progress?: number
  error?: string | null
  startedAt?: string | null
  completedAt?: string | null
  attempts?: number
}
