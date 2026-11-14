import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SessionRepository } from '../db/repositories/SessionRepository'
import { getDataDir } from '../db/connection'
import { removeFile, removeFileReporting } from '../utils/file-ops'
import { tiptapToPlainText } from '../ml/tiptap-plain-text'
import type { Session, SessionStatus, UpdateSessionInput } from '../../shared/types'
import type { SummaryRecord } from '../../shared/types/IpcApi'
// Cyclic import: TaskQueueService imports SessionService too. The cycle is broken
// at call-time — getTaskQueue() is only invoked inside deleteSession() at runtime,
// not during module initialisation. Bundlers and ts-node handle this correctly.
import { getTaskQueue } from './TaskQueueService'

export type { SummaryRecord }

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  recording: ['queued', 'error'],
  queued: ['processing', 'error'],
  // processing → processing is legitimate (advancing through tasks while keeping the same status)
  processing: ['processing', 'review', 'error'],
  review: ['error'],
  // From error, retry pushes back to queued (re-enters the queue) or recording
  // for re-record. error → error ist erlaubt, damit ein zweiter Fehler die
  // aktualisierte errorMessage schreiben kann (sonst divergieren DB und UI).
  error: ['recording', 'queued', 'error']
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

  /**
   * Deletes a session with everything derived from it (Issue #202).
   *
   * Two phases, so an interrupted deletion is finished at the next start:
   * 1. mark the row (deleting_at) — durable, from now on every read that
   *    reaches the user treats the session as gone;
   * 2. abort its tasks, remove its files, delete the row, checkpoint the WAL.
   * If a file cannot be removed, the mark stays and finishPendingDeletions()
   * retries at the next start; the row's text content is scrubbed right away.
   *
   * Returns true once the deletion is confirmed (also when phase 2 has to be
   * finished later), false only if the session does not exist.
   */
  deleteSession(id: string): boolean {
    const session = this.repository.findByIdIncludingDeleting(id)
    if (!session) return false

    this.repository.markDeleting(id)

    // Issue #80 DR-6: abort any running pipeline + cancel pending tasks BEFORE
    // file cleanup, so the executor's writes don't race the unlink calls.
    // getTaskQueue() returns the singleton or throws if not initialised — guard.
    try {
      getTaskQueue().abortRunningForSession(id)
    } catch {
      // TaskQueue not initialised (e.g. during isolated SessionService tests) — skip
    }

    this.completeDeletion(session)
    return true
  }

  /**
   * Startup step (before the task queue runs): finishes every deletion that
   * was interrupted or could not remove all files. Returns the number of
   * sessions that are now completely gone.
   */
  finishPendingDeletions(): number {
    let finished = 0
    for (const session of this.repository.findMarkedForDeletion()) {
      if (this.completeDeletion(session)) finished++
    }
    return finished
  }

  /**
   * Called by the task queue after every executor run (#202): if the session
   * was deleted meanwhile, an executor that ignored the abort may have written
   * files after the deletion removed them. Removes them again with the same
   * code as the deletion; a still-marked row is finished. No-op for an
   * existing, unmarked session. Returns true if the session was deleted.
   */
  removeFilesIfDeleted(id: string): boolean {
    const row = this.repository.findByIdIncludingDeleting(id)
    if (row && !this.repository.isMarkedForDeletion(id)) return false
    if (row) {
      this.completeDeletion(row)
    } else if (!this.removeSessionFiles(id, [])) {
      console.error(
        `[SessionService] Nachträglich geschriebene Dateien der gelöschten Sitzung ${id} konnten nicht alle entfernt werden — der Start-Sweep holt das nach`
      )
    }
    return true
  }

  /** IDs of every session row, including rows still marked for deletion. */
  getAllSessionIds(): string[] {
    return this.repository.findAllIds()
  }

  private completeDeletion(session: Session): boolean {
    const filesGone = this.removeSessionFiles(session.id, [
      session.audioPath,
      session.transcriptPath,
      session.anonymizedPath,
      session.diarizationPath,
      session.alignedTranscriptPath,
      session.pdfPath,
      session.extractedPath
    ])
    if (filesGone) {
      this.repository.delete(session.id)
    } else {
      this.repository.scrubMarkedContent(session.id)
      console.error(
        `[SessionService] Dateien der Sitzung ${session.id} konnten nicht alle entfernt werden — Löschen wird beim nächsten Start abgeschlossen`
      )
    }
    // Ein blockierter Checkpoint (busy) wird beim nächsten Löschen und beim
    // nächsten Start nachgeholt (initDatabase checkpointet immer).
    try {
      if (!this.repository.checkpoint()) {
        console.error(
          '[SessionService] WAL-Checkpoint nach dem Löschen blockiert — wird beim nächsten Löschen bzw. Start nachgeholt'
        )
      }
    } catch (error) {
      console.error('[SessionService] WAL-Checkpoint nach dem Löschen fehlgeschlagen:', error)
    }
    return filesGone
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

  /**
   * Removes every file a session can have: the stored paths plus the
   * convention paths (a deletion during import or mid-pipeline may happen
   * before the path was written to the row). Returns false if any file still
   * exists afterwards.
   */
  private removeSessionFiles(id: string, storedPaths: (string | null)[]): boolean {
    const dataDir = getDataDir()
    const filePaths = new Set(
      [
        ...storedPaths,
        join(dataDir, 'audio', `${id}.wav`),
        join(dataDir, 'transcripts', `${id}.json`),
        join(dataDir, 'transcripts', `${id}-aligned.json`),
        join(dataDir, 'diarization', `${id}.json`),
        join(dataDir, 'anonymized', `${id}.json`),
        join(dataDir, 'pdf', `${id}.pdf`),
        join(dataDir, 'extracted', `${id}.json`),
        join(dataDir, 'recovery', `${id}.pcm`)
      ].filter((p): p is string => typeof p === 'string' && p.length > 0)
    )

    let allGone = true
    for (const filePath of filePaths) {
      if (!removeFileReporting(filePath)) allGone = false
    }
    return allGone
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
   * inlines placeholder chips as `[TYPE NUMBER]`).
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
