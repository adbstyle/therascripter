export type TaskType =
  | 'transcription'
  | 'diarization'
  | 'alignment'
  | 'extraction'
  | 'ocr'
  | 'anonymization'

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

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
}
