import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { getDataDir } from '../db/connection'
import { removeFile } from '../utils/file-ops'
import { tiptapToPlainText } from '../ml/tiptap-plain-text'
import type { Session, SessionStatus, UpdateSessionInput } from '../../shared/types'
import type { SummaryRecord } from '../../shared/types/IpcApi'

export type { SummaryRecord }

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  recording: ['queued', 'error'],
  queued: ['processing', 'error'],
  // processing → processing is legitimate (advancing through tasks while keeping the same status)
  processing: ['processing', 'review', 'error'],
  review: ['error'],
  // From error, retry pushes back to queued (re-enters the queue) or recording for re-record
  error: ['recording', 'queued']
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
      status: type === 'audio' ? 'recording' : 'queued',
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

  /**
   * Reads the persisted anonymized TipTap document for a session and flattens it
   * to plain text suitable for LLM input (drops speaker labels + timestamps,
   * inlines placeholder chips by label).
   */
  getAnonymizedPlainText(sessionId: string): string {
    const session = this.repository.findById(sessionId)
    if (!session?.anonymizedPath) {
      throw new Error(`Session ${sessionId} hat kein anonymisiertes Dokument`)
    }
    const raw = readFileSync(session.anonymizedPath, 'utf-8')
    const doc = JSON.parse(raw)
    return tiptapToPlainText(doc)
  }

  /**
   * Returns a SummaryRecord if either title or summary is non-empty.
   * The renderer renders a literal placeholder when title is empty (see
   * SessionCard / EditableSessionTitle); the actual createdAt timestamp
   * is shown separately in the card chrome, so no date-derived title
   * fallback is needed in this layer.
   *
   * Title-reuse semantics: `sessions.title` is the same column that backs
   * both (a) auto-generated session labels written at createSession time
   * (e.g. 'Aufnahme 14.02.2026 14:30') and (b) the LLM-generated title
   * written by SummarizationExecutor. We deliberately reuse the column
   * instead of adding a separate `llm_title` field — pre-feature sessions
   * already have non-NULL titles, and the renderer's contract is the
   * same regardless of provenance: show the title, let the user edit it.
   * Provenance is only knowable from `summaryModelId` (NULL after a
   * user edit, set after an LLM run).
   */
  getSummary(sessionId: string): SummaryRecord | null {
    const session = this.repository.findById(sessionId)
    if (!session) return null
    const hasTitle = typeof session.title === 'string' && session.title.trim().length > 0
    const hasSummary = typeof session.summary === 'string' && session.summary.trim().length > 0
    if (!hasTitle && !hasSummary) return null
    return {
      title: hasTitle ? session.title : null,
      text: session.summary ?? '',
      modelId: session.summaryModelId,
      summarizedAt: session.summarizedAt
    }
  }

  /** Persists LLM-generated title + summary in one update. */
  saveGeneratedSummary(
    sessionId: string,
    title: string,
    text: string,
    modelId: string
  ): Session | null {
    return this.repository.update(sessionId, {
      title,
      summary: text,
      summaryModelId: modelId,
      summarizedAt: new Date().toISOString()
    })
  }

  /** User-edited title. Empty string is rendered as a placeholder in the view layer (createdAt is shown separately). */
  updateTitle(sessionId: string, title: string): Session | null {
    return this.repository.update(sessionId, { title: title.trim() })
  }

  /**
   * User-edited summary text. Clearing the model id signals that the text is no longer
   * LLM-authoritative — future model upgrades will not assume the user's edit can
   * be regenerated automatically.
   */
  updateSummaryText(sessionId: string, text: string): Session | null {
    const trimmed = text.trim()
    return this.repository.update(sessionId, {
      summary: trimmed.length > 0 ? trimmed : null,
      summaryModelId: null
    })
  }
}

// Status values where self-transitions are legitimate.
// 'processing' stays through every task; 'review' re-anonymises in place.
const IDEMPOTENT_STATUSES: SessionStatus[] = ['processing', 'review']

function isValidTransition(current: SessionStatus, next: SessionStatus): boolean {
  if (current === next && IDEMPOTENT_STATUSES.includes(current)) return true
  return VALID_TRANSITIONS[current]?.includes(next) ?? false
}
