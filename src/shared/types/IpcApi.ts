import type { Session } from './Session'

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
}

export interface IpcApi {
  sessions: SessionApi
  recording: RecordingApi
}
