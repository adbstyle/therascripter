import type Database from 'better-sqlite3'
import { join } from 'path'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { getDataDir } from '../db/connection'
import { removeFile } from '../utils/file-ops'
import type { Session, SessionStatus, UpdateSessionInput } from '../../shared/types'

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  recording: ['transcribing', 'error'],
  transcribing: ['diarizing', 'error'],
  diarizing: ['anonymizing', 'error'],
  extracting: ['anonymizing', 'error'],
  anonymizing: ['review', 'error'],
  review: ['error'],
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
      // Auto-set reviewAt on first transition to 'review' — never reset on re-anonymization
      if (input.status === 'review' && !session.reviewAt) {
        input = { ...input, reviewAt: new Date().toISOString() }
      }
    }
    return this.repository.update(id, input)
  }

  renameSession(id: string, title: string): Session | null {
    return this.repository.update(id, { title })
  }

  deleteSession(id: string): boolean {
    const session = this.repository.findById(id)
    if (!session) return false

    this.cleanupSessionFiles(session)
    return this.repository.delete(id)
  }

  cleanupOldSessions(): number {
    const expired = this.repository.findOlderThan(30)
    let deleted = 0
    for (const session of expired) {
      this.cleanupSessionFiles(session)
      if (this.repository.delete(session.id)) deleted++
    }
    return deleted
  }

  cleanupSourceFiles(): number {
    const sessions = this.repository.findReadyForSourceFileDeletion()
    let cleaned = 0
    for (const session of sessions) {
      this.deleteSourceFile(session)
      const update =
        session.type === 'audio'
          ? this.repository.update(session.id, { audioPath: null })
          : this.repository.update(session.id, { pdfPath: null })
      if (update) cleaned++
    }
    return cleaned
  }

  private cleanupSessionFiles(session: Session): void {
    const dataDir = getDataDir()
    const filePaths = [
      session.audioPath,
      session.transcriptPath,
      session.anonymizedPath,
      session.diarizationPath,
      session.alignedTranscriptPath,
      session.pdfPath,
      session.extractedPath ??
        (session.type === 'pdf' ? join(dataDir, 'extracted', `${session.id}.json`) : null),
      join(dataDir, 'recovery', `${session.id}.pcm`)
    ]

    for (const filePath of filePaths) {
      if (filePath) {
        removeFile(filePath)
      }
    }
  }

  private deleteSourceFile(session: Session): void {
    const filePath = session.type === 'audio' ? session.audioPath : session.pdfPath
    if (filePath) {
      removeFile(filePath)
    }
  }

  generateAudioPath(sessionId: string): string {
    return join(getDataDir(), 'audio', `${sessionId}.wav`)
  }

  generateTranscriptPath(sessionId: string): string {
    return join(getDataDir(), 'transcripts', `${sessionId}.json`)
  }

  generateDiarizationPath(sessionId: string): string {
    return join(getDataDir(), 'diarization', `${sessionId}.json`)
  }

  generateAnonymizedPath(sessionId: string): string {
    return join(getDataDir(), 'anonymized', `${sessionId}.json`)
  }

  generateAlignedTranscriptPath(sessionId: string): string {
    return join(getDataDir(), 'transcripts', `${sessionId}-aligned.json`)
  }
}

// Processing statuses where multiple task types map to the same session status
// (e.g., both diarization and alignment → 'diarizing'), making self-transitions legitimate.
const IDEMPOTENT_STATUSES: SessionStatus[] = [
  'transcribing',
  'diarizing',
  'extracting',
  'anonymizing',
  'review' // re-anonymization triggers review → review
]

function isValidTransition(current: SessionStatus, next: SessionStatus): boolean {
  if (current === next && IDEMPOTENT_STATUSES.includes(current)) return true
  return VALID_TRANSITIONS[current]?.includes(next) ?? false
}
