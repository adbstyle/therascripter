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

interface SessionRow {
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

function rowToSession(row: SessionRow): Session {
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
    entityMap: parseEntityMap(row.entity_map, row.id),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewAt: row.review_at,
    wordCount: row.word_count,
    anonymizationCount: row.anonymization_count,
    summary: row.summary,
    summaryModelId: row.summary_model_id,
    summarizedAt: row.summarized_at,
    plannedSteps: row.planned_steps ? (JSON.parse(row.planned_steps) as TaskType[]) : null,
    retryCount: row.retry_count,
    pdfHasScannedPages: row.pdf_has_scanned_pages == null ? null : row.pdf_has_scanned_pages === 1,
    processedWithModels: parseProcessedModels(row.processed_with_models, row.id)
  }
}

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
   */
  findAll(): Session[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, type, status, audio_path, transcript_path,
                anonymized_path, diarization_path, aligned_transcript_path,
                pdf_path, extracted_path, NULL AS entity_map, error_message,
                created_at, updated_at, review_at, word_count,
                anonymization_count, summary, summary_model_id, summarized_at,
                planned_steps, retry_count, pdf_has_scanned_pages,
                NULL AS processed_with_models
         FROM sessions WHERE deleting_at IS NULL ORDER BY created_at DESC`
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

    if (sets.length === 0) return this.findById(id)

    sets.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    return this.findById(id)
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
    return result.changes > 0
  }

  /**
   * Removes the content of a marked row while its files could not be removed
   * yet: the paths stay (the next start needs them), title, summary, entity
   * map (originals of every placeholder) and error message go immediately.
   */
  scrubMarkedContent(id: string): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET title = '', summary = NULL, entity_map = NULL, error_message = NULL
         WHERE id = ? AND deleting_at IS NOT NULL`
      )
      .run(id)
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
   * a deleted row in either file (Issue #202, Postcondition 1).
   */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
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
