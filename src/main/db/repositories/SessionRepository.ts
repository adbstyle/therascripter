import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  Session,
  SessionStatus,
  SessionType,
  CreateSessionInput,
  UpdateSessionInput,
  EntityMap,
  TaskType,
  ProcessedModelsSnapshot
} from '../../../shared/types'
import { parsePlaceholderSnapshot } from '../../../shared/utils/resolvePlaceholders'
import { walCheckpointTruncate } from '../maintenance'
import { refreshPlainTexts } from '../plainTexts'
import { stripAbsolutePaths } from '../../utils/userFacingError'

export interface SessionRow {
  id: string
  title: string
  type: SessionType
  status: SessionStatus
  audio_path: string | null
  transcript_path: string | null
  anonymized_path: string | null
  diarization_path: string | null
  aligned_transcript_path: string | null
  pdf_path: string | null
  extracted_path: string | null
  entity_map: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  review_at: string | null
  word_count: number | null
  anonymization_count: number | null
  summary: string | null
  summary_model_id: string | null
  summarized_at: string | null
  planned_steps: string | null
  retry_count: number
  pdf_has_scanned_pages: number | null
  processed_with_models: string | null
  /** Not selected by the list projection (clear names, Issue #203). */
  title_entity_snapshot?: string | null
  summary_entity_snapshot?: string | null
  /** Klartext computed on write (plainTexts.ts); NULL = same as title/summary. */
  title_plain: string | null
  summary_plain: string | null
  /** Migration 020 (#205) — ISO day the PDF was written. */
  document_date: string | null
}

/** Columns whose change can change the stored Klartext (Issue #203). */
const PLAIN_SOURCE_INPUTS = [
  'title',
  'summary',
  'entityMap',
  'titleEntitySnapshot',
  'summaryEntitySnapshot'
] as const

/** Inhalte, die die Suche indexiert (search_rev, Migration 021). */
function touchesSearchContent(input: UpdateSessionInput): boolean {
  return (
    input.title !== undefined ||
    input.summary !== undefined ||
    input.entityMap !== undefined ||
    input.status === 'review'
  )
}

function parseEntityMap(json: string | null, sessionId: string): EntityMap | null {
  if (!json) return null
  try {
    return JSON.parse(json) as EntityMap
  } catch {
    console.error(`Corrupted entity_map in session ${sessionId}, treating as null`)
    return null
  }
}

function parseProcessedModels(
  json: string | null,
  sessionId: string
): ProcessedModelsSnapshot | null {
  if (!json) return null
  try {
    return JSON.parse(json) as ProcessedModelsSnapshot
  } catch {
    // A corrupted blob shouldn't hide the session — degrade to "legacy
    // unknown" so the UI shows the neutral hint instead of crashing.
    console.error(`Corrupted processed_with_models in session ${sessionId}, treating as null`)
    return null
  }
}

export function rowToSession(row: SessionRow): Session {
  const entityMap = parseEntityMap(row.entity_map, row.id)
  const summary = row.summary
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    audioPath: row.audio_path,
    transcriptPath: row.transcript_path,
    anonymizedPath: row.anonymized_path,
    diarizationPath: row.diarization_path,
    alignedTranscriptPath: row.aligned_transcript_path,
    pdfPath: row.pdf_path,
    extractedPath: row.extracted_path,
    entityMap,
    // Auch Meldungen aus der Zeit vor dem Filter beim Schreiben: nie ein Pfad
    // zum Renderer (Benutzername), idempotent
    errorMessage: row.error_message === null ? null : stripAbsolutePaths(row.error_message),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewAt: row.review_at,
    wordCount: row.word_count,
    anonymizationCount: row.anonymization_count,
    summary,
    summaryModelId: row.summary_model_id,
    summarizedAt: row.summarized_at,
    plannedSteps: row.planned_steps ? (JSON.parse(row.planned_steps) as TaskType[]) : null,
    retryCount: row.retry_count,
    pdfHasScannedPages: row.pdf_has_scanned_pages == null ? null : row.pdf_has_scanned_pages === 1,
    processedWithModels: parseProcessedModels(row.processed_with_models, row.id),
    titleEntitySnapshot: parsePlaceholderSnapshot(row.title_entity_snapshot),
    summaryEntitySnapshot: parsePlaceholderSnapshot(row.summary_entity_snapshot),
    titlePlain: row.title_plain ?? row.title,
    summaryPlain: summary == null ? null : (row.summary_plain ?? summary),
    documentDate: row.document_date ?? null
  }
}

/**
 * Spalten der Listen-Projektion (siehe findAll), qualifiziert mit dem Alias
 * `s` für `sessions`. Exportiert, damit spätere Abfragen (Verlauf eines
 * Patientendossiers, «Zuletzt geöffnet», Epic #192) dieselbe Form liefern und
 * rowToSession wiederverwenden — inklusive der Klartext-Spalten aus #203.
 */
export const SESSION_LIST_COLUMNS = `s.id, s.title, s.type, s.status, s.audio_path, s.transcript_path,
  s.anonymized_path, s.diarization_path, s.aligned_transcript_path,
  s.pdf_path, s.extracted_path, NULL AS entity_map, s.error_message,
  s.created_at, s.updated_at, s.review_at, s.word_count,
  s.anonymization_count, s.summary, s.summary_model_id, s.summarized_at,
  s.planned_steps, s.retry_count, s.pdf_has_scanned_pages,
  NULL AS processed_with_models,
  s.title_plain, s.summary_plain, s.document_date`

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID()
    const now = new Date().toISOString()
    const status = input.status ?? (input.type === 'audio' ? 'recording' : 'queued')

    this.db
      .prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, pdf_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.type,
        status,
        input.audioPath ?? null,
        input.pdfPath ?? null,
        now,
        now
      )

    return this.findById(id)!
  }

  /**
   * Sessions marked for deletion (deleting_at, Issue #202) count as gone:
   * neither the UI nor a still-running executor may read or update them.
   * Only the deletion itself reads them via findByIdIncludingDeleting.
   */
  findById(id: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ? AND deleting_at IS NULL')
      .get(id) as SessionRow | undefined
    return row ? rowToSession(row) : null
  }

  findByIdIncludingDeleting(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return row ? rowToSession(row) : null
  }

  /**
   * Listen-Projektion: entity_map und processed_with_models werden bewusst
   * NICHT selektiert (und bleiben null im Ergebnis). Kein Consumer der Liste
   * (Dashboard via session:list, broadcastQueuePositions,
   * recoverOrphanedSessions, checkForRecovery, Auto-Deletion) liest diese
   * Blobs — der JSON-Parse pro Row und der IPC-Payload skalierten mit der
   * Library-Größe, und die Liste wird bei jedem Task-Event refetcht.
   * Detail-Reads (findById, z. B. via review:load) liefern sie weiterhin.
   *
   * Issue #203: Für die Klartext-Ansicht liest die Liste nur die beim
   * Schreiben berechneten title_plain/summary_plain — weder entity_map noch
   * die Snapshots (Token → Klarname) werden selektiert oder geparst.
   */
  findAll(): Session[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_LIST_COLUMNS}
         FROM sessions s WHERE s.deleting_at IS NULL ORDER BY s.created_at DESC`
      )
      .all() as SessionRow[]
    return rows.map(rowToSession)
  }

  update(id: string, input: UpdateSessionInput): Session | null {
    if (!this.findById(id)) return null

    const sets: string[] = []
    const values: unknown[] = []

    if (input.title !== undefined) {
      sets.push('title = ?')
      values.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      values.push(input.status)
    }
    if (input.audioPath !== undefined) {
      sets.push('audio_path = ?')
      values.push(input.audioPath)
    }
    if (input.transcriptPath !== undefined) {
      sets.push('transcript_path = ?')
      values.push(input.transcriptPath)
    }
    if (input.anonymizedPath !== undefined) {
      sets.push('anonymized_path = ?')
      values.push(input.anonymizedPath)
    }
    if (input.diarizationPath !== undefined) {
      sets.push('diarization_path = ?')
      values.push(input.diarizationPath)
    }
    if (input.alignedTranscriptPath !== undefined) {
      sets.push('aligned_transcript_path = ?')
      values.push(input.alignedTranscriptPath)
    }
    if (input.pdfPath !== undefined) {
      sets.push('pdf_path = ?')
      values.push(input.pdfPath)
    }
    if (input.extractedPath !== undefined) {
      sets.push('extracted_path = ?')
      values.push(input.extractedPath)
    }
    if (input.entityMap !== undefined) {
      sets.push('entity_map = ?')
      values.push(input.entityMap ? JSON.stringify(input.entityMap) : null)
    }
    if (input.errorMessage !== undefined) {
      sets.push('error_message = ?')
      values.push(input.errorMessage)
    }
    if (input.reviewAt !== undefined) {
      sets.push('review_at = ?')
      values.push(input.reviewAt)
    }
    if (input.wordCount !== undefined) {
      sets.push('word_count = ?')
      values.push(input.wordCount)
    }
    if (input.anonymizationCount !== undefined) {
      sets.push('anonymization_count = ?')
      values.push(input.anonymizationCount)
    }
    if (input.summary !== undefined) {
      sets.push('summary = ?')
      values.push(input.summary)
    }
    if (input.summaryModelId !== undefined) {
      sets.push('summary_model_id = ?')
      values.push(input.summaryModelId)
    }
    if (input.summarizedAt !== undefined) {
      sets.push('summarized_at = ?')
      values.push(input.summarizedAt)
    }
    if (input.plannedSteps !== undefined) {
      sets.push('planned_steps = ?')
      values.push(input.plannedSteps ? JSON.stringify(input.plannedSteps) : null)
    }
    if (input.retryCount !== undefined) {
      sets.push('retry_count = ?')
      values.push(input.retryCount)
    }
    if (input.pdfHasScannedPages !== undefined) {
      sets.push('pdf_has_scanned_pages = ?')
      values.push(input.pdfHasScannedPages == null ? null : input.pdfHasScannedPages ? 1 : 0)
    }
    if (input.processedWithModels !== undefined) {
      sets.push('processed_with_models = ?')
      values.push(
        input.processedWithModels === null ? null : JSON.stringify(input.processedWithModels)
      )
    }

    if (input.titleEntitySnapshot !== undefined) {
      sets.push('title_entity_snapshot = ?')
      values.push(input.titleEntitySnapshot ? JSON.stringify(input.titleEntitySnapshot) : null)
    }
    if (input.summaryEntitySnapshot !== undefined) {
      sets.push('summary_entity_snapshot = ?')
      values.push(input.summaryEntitySnapshot ? JSON.stringify(input.summaryEntitySnapshot) : null)
    }

    if (sets.length === 0) return this.findById(id)

    // Epic #192 (#212) — jede inhaltliche Änderung macht die Sitzung für die
    // Textphase der Suche «zu bearbeiten»: Titel, Zusammenfassung,
    // Dokument/EntityMap (review:save, Pseudonymisierung) und das Erreichen
    // von review. Reine Pfad-, Zähler- und Fortschritts-Updates nicht.
    if (touchesSearchContent(input)) sets.push('search_rev = search_rev + 1')

    sets.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    // Issue #203 — keep the stored Klartext in step with every writer
    // (summarization, title/summary edits, review:save changing entity_map)
    if (PLAIN_SOURCE_INPUTS.some((key) => input[key] !== undefined)) {
      refreshPlainTexts(this.db, id)
    }

    return this.findById(id)
  }

  /**
   * #205 — sets the document date of a PDF (ISO day). Never NULL: a date once
   * set can be changed but not reset to the import date (Out of Scope 3).
   * Returns false if there is no such PDF (missing, being deleted, or audio).
   */
  setDocumentDate(id: string, documentDate: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE sessions SET document_date = ?, updated_at = ?
         WHERE id = ? AND type = 'pdf' AND deleting_at IS NULL`
      )
      .run(documentDate, new Date().toISOString(), id)
    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  /**
   * Phase 1 of a restart-proof deletion (Issue #202): durable before any file
   * is touched. Keeps an existing mark (a repeated delete does not reset it).
   */
  markDeleting(id: string): boolean {
    const result = this.db
      .prepare('UPDATE sessions SET deleting_at = COALESCE(deleting_at, ?) WHERE id = ?')
      .run(new Date().toISOString(), id)
    if (result.changes > 0) {
      // «Zuletzt geöffnet» (#213 PC 2): sofort und mit der Markierung, nicht
      // erst mit der Zeile — die kann bis zum nächsten Start liegen bleiben
      this.db.prepare('DELETE FROM recent_items WHERE session_id = ?').run(id)
    }
    return result.changes > 0
  }

  /**
   * Removes the content of a marked row while its files could not be removed
   * yet: the paths stay (the next start needs them), title, summary, entity
   * map (originals of every placeholder) and error message go immediately —
   * as do the document date, the dossier assignments (#205 PC 5/6) and the
   * «recently opened» entry (#213 PC 2).
   */
  scrubMarkedContent(id: string): void {
    const marked = this.db
      .prepare(
        `UPDATE sessions
         SET title = '', summary = NULL, entity_map = NULL, error_message = NULL,
             title_entity_snapshot = NULL, summary_entity_snapshot = NULL,
             title_plain = NULL, summary_plain = NULL, document_date = NULL
         WHERE id = ? AND deleting_at IS NOT NULL`
      )
      .run(id)
    if (marked.changes > 0) {
      this.db.prepare('DELETE FROM session_dossiers WHERE session_id = ?').run(id)
      // «Zuletzt geöffnet» (#213 PC 2): kein Verweis bleibt, bis die Zeile geht
      this.db.prepare('DELETE FROM recent_items WHERE session_id = ?').run(id)
    }
  }

  isMarkedForDeletion(id: string): boolean {
    const row = this.db.prepare('SELECT deleting_at FROM sessions WHERE id = ?').get(id) as
      | { deleting_at: string | null }
      | undefined
    return row?.deleting_at != null
  }

  findMarkedForDeletion(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE deleting_at IS NOT NULL ORDER BY deleting_at ASC')
      .all() as SessionRow[]
    return rows.map(rowToSession)
  }

  /** IDs of every row, including rows marked for deletion. */
  findAllIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  /**
   * Moves the WAL content into the database file and truncates the WAL.
   * Together with PRAGMA secure_delete (initDatabase) this leaves no copy of
   * a deleted row in either file (Issue #202, Postcondition 1). Returns false
   * if the checkpoint was blocked (busy) and did not complete.
   */
  checkpoint(): boolean {
    return walCheckpointTruncate(this.db)
  }

  findReadyForSourceFileDeletion(): Session[] {
    const cutoff = new Date()
    cutoff.setHours(cutoff.getHours() - 24)

    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'review'
           AND deleting_at IS NULL
           AND review_at < ?
           AND (audio_path IS NOT NULL OR pdf_path IS NOT NULL)
         ORDER BY review_at ASC`
      )
      .all(cutoff.toISOString()) as SessionRow[]
    return rows.map(rowToSession)
  }
}
