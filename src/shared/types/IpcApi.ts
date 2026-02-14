import type { Session } from './Session'

export interface SessionApi {
  list(): Promise<Session[]>
  delete(sessionId: string): Promise<boolean>
  rename(sessionId: string, title: string): Promise<Session | null>
}

export interface IpcApi {
  sessions: SessionApi
}
