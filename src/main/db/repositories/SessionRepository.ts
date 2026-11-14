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
import {
  parsePlaceholderSnapshot,
  resolvePlaceholders
} from '../../../shared/utils/resolvePlaceholders'

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
  title_entity_snapshot: string | null
  summary_entity_snapshot: string | null
  /**
   * Only in the list projection: entity_map of rows whose title or summary
   * contains a token, used solely to resolve them for the Klartext view.
   */
  entity_map_for_plain?: string | null
}

/** Cheap pre-check: without a `[` no placeholder token can be in the text. */
function mayHoldToken(text: string | null): boolean {
  return text != null && text.includes('[')
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
  const entityMap = parseEntityMap(row.entity_map, row.id)
  const titleEntitySnapshot = parsePlaceholderSnapshot(row.title_entity_snapshot)
  const summaryEntitySnapshot = parsePlaceholderSnapshot(row.summary_entity_snapshot)

  // Issue #203 — Klartext title/summary. The EntityMap is parsed only when a
  // text can hold a token at all (list: SQL already nulls it otherwise).
  let titlePlain = row.title
  let summaryPlain = row.summary
  if (mayHoldToken(row.title) || mayHoldToken(row.summary)) {
    const mapForPlain =
      entityMap ??
      (row.entity_map_for_plain ? parseEntityMap(row.entity_map_for_plain, row.id) : null)
    titlePlain = resolvePlaceholders(row.title, mapForPlain, titleEntitySnapshot)
    summaryPlain =
      row.summary == null
        ? null
        : resolvePlaceholders(row.summary, mapForPlain, summaryEntitySnapshot)
  }

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
    processedWithModels: parseProcessedModels(row.processed_with_models, row.id),
    titleEntitySnapshot,
    summaryEntitySnapshot,
    titlePlain,
    summaryPlain
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

  findById(id: string): Session | null {
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
   * Issue #203: Für die Klartext-Ansicht löst rowToSession Titel und
   * Zusammenfassung auf; dafür liest die Liste entity_map nur bei Zeilen,
   * deren Titel oder Zusammenfassung überhaupt ein `[` enthält.
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
                NULL AS processed_with_models,
                title_entity_snapshot, summary_entity_snapshot,
                CASE WHEN instr(title, '[') > 0 OR instr(COALESCE(summary, ''), '[') > 0
                     THEN entity_map END AS entity_map_for_plain
         FROM sessions ORDER BY created_at DESC`
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

  findOlderThan(days: number): Session[] {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE created_at < ? ORDER BY created_at ASC')
      .all(cutoff.toISOString()) as SessionRow[]
    return rows.map(rowToSession)
  }

  findReadyForSourceFileDeletion(): Session[] {
    const cutoff = new Date()
    cutoff.setHours(cutoff.getHours() - 24)

    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'review'
           AND review_at < ?
           AND (audio_path IS NOT NULL OR pdf_path IS NOT NULL)
         ORDER BY review_at ASC`
      )
      .all(cutoff.toISOString()) as SessionRow[]
    return rows.map(rowToSession)
  }
}
