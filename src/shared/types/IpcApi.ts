import type { Session } from './Session'
import type { Task, TaskType } from './Task'

export interface SessionApi {
  list(): Promise<Session[]>
  delete(sessionId: string): Promise<boolean>
  rename(sessionId: string, title: string): Promise<Session | null>
}

export interface RecordingApi {
  start(): Promise<{ sessionId: string }>
  stop(sessionId: string): Promise<{ durationSeconds: number }>
  sendData(sessionId: string, samples: ArrayBuffer): void
  onDuration(callback: (data: { seconds: number }) => void): () => void
  onError(callback: (data: { message: string }) => void): () => void
  onAutoStopped(callback: () => void): () => void
}

export interface SettingsApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface TaskProgressData {
  sessionId: string
  taskType: TaskType
  progress: number
}

export interface TaskCompletedData {
  sessionId: string
  taskType: TaskType
}

export interface TaskErrorData {
  sessionId: string
  taskType: TaskType
  error: string
}

export interface TasksApi {
  getSessionTasks(sessionId: string): Promise<Task[]>
  onProgress(callback: (data: TaskProgressData) => void): () => void
  onCompleted(callback: (data: TaskCompletedData) => void): () => void
  onError(callback: (data: TaskErrorData) => void): () => void
}

export interface IpcApi {
  sessions: SessionApi
  recording: RecordingApi
  settings: SettingsApi
  tasks: TasksApi
}
