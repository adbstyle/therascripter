import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  Session,
  SessionStatus,
  SessionType,
  CreateSessionInput,
  UpdateSessionInput,
  EntityMap
} from '../../../shared/types'

interface SessionRow {
  id: string
  title: string
  type: SessionType
  status: SessionStatus
  audio_path: string | null
  transcript_path: string | null
  anonymized_path: string | null
  pdf_path: string | null
  entity_map: string | null
  error_message: string | null
  created_at: string
  updated_at: string
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

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    audioPath: row.audio_path,
    transcriptPath: row.transcript_path,
    anonymizedPath: row.anonymized_path,
    pdfPath: row.pdf_path,
    entityMap: parseEntityMap(row.entity_map, row.id),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class SessionRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID()
    const now = new Date().toISOString()
    const status = input.status ?? (input.type === 'audio' ? 'recording' : 'extracting')

    this.db
      .prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, pdf_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.title, input.type, status, input.audioPath ?? null, input.pdfPath ?? null, now, now)

    return this.findById(id)!
  }

  findById(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined
    return row ? rowToSession(row) : null
  }

  findAll(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC')
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
    if (input.pdfPath !== undefined) {
      sets.push('pdf_path = ?')
      values.push(input.pdfPath)
    }
    if (input.entityMap !== undefined) {
      sets.push('entity_map = ?')
      values.push(input.entityMap ? JSON.stringify(input.entityMap) : null)
    }
    if (input.errorMessage !== undefined) {
      sets.push('error_message = ?')
      values.push(input.errorMessage)
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
}
