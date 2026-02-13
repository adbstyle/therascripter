import type Database from 'better-sqlite3'
import { join } from 'path'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { getDataDir } from '../db/connection'
import type { Session, SessionStatus, UpdateSessionInput } from '../../shared/types'

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  recording: ['transcribing', 'error'],
  transcribing: ['diarizing', 'error'],
  diarizing: ['anonymizing', 'error'],
  extracting: ['anonymizing', 'error'],
  anonymizing: ['review', 'error'],
  review: ['review', 'error'],
  error: ['recording', 'transcribing', 'diarizing', 'extracting', 'anonymizing']
}

export class SessionService {
  private repository: SessionRepository

  constructor(db: Database.Database) {
    this.repository = new SessionRepository(db)
  }

  createSession(title: string, type: 'audio' | 'pdf', pdfPath?: string): Session {
    return this.repository.create({
      title,
      type,
      status: type === 'audio' ? 'recording' : 'extracting',
      pdfPath
    })
  }

  getSession(id: string): Session | null {
    return this.repository.findById(id)
  }

  getAllSessions(): Session[] {
    return this.repository.findAll()
  }

  // Status changes throw on invalid transitions (caller logic error).
  // Non-status updates return null if session not found (standard CRUD).
  updateSession(id: string, input: UpdateSessionInput): Session | null {
    if (input.status !== undefined) {
      const session = this.repository.findById(id)
      if (!session) throw new Error(`Session ${id} not found`)
      if (!isValidTransition(session.status, input.status)) {
        throw new Error(`Invalid status transition: ${session.status} → ${input.status}`)
      }
    }
    return this.repository.update(id, input)
  }

  renameSession(id: string, title: string): Session | null {
    return this.repository.update(id, { title })
  }

  deleteSession(id: string): boolean {
    return this.repository.delete(id)
  }

  cleanupOldSessions(): number {
    const expired = this.repository.findOlderThan(30)
    let deleted = 0
    for (const session of expired) {
      if (this.repository.delete(session.id)) deleted++
    }
    return deleted
  }

  generateAudioPath(sessionId: string): string {
    return join(getDataDir(), 'audio', `${sessionId}.wav`)
  }

  generateTranscriptPath(sessionId: string): string {
    return join(getDataDir(), 'transcripts', `${sessionId}.json`)
  }

  generateAnonymizedPath(sessionId: string): string {
    return join(getDataDir(), 'anonymized', `${sessionId}.json`)
  }
}

function isValidTransition(current: SessionStatus, next: SessionStatus): boolean {
  return VALID_TRANSITIONS[current]?.includes(next) ?? false
}
