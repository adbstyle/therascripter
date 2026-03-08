import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  Task,
  TaskStatus,
  TaskType,
  CreateTaskInput,
  UpdateTaskInput
} from '../../../shared/types'

interface TaskRow {
  id: string
  session_id: string
  type: TaskType
  status: TaskStatus
  progress: number
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

export class TaskRepository {
  constructor(private db: Database.Database) {}

  create(input: CreateTaskInput): Task {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO task_queue (id, session_id, type, status, progress, error, created_at, started_at, completed_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, NULL)`
      )
      .run(id, input.sessionId, input.type, now)

    return this.findById(id)!
  }

  findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM task_queue WHERE id = ?').get(id) as
      | TaskRow
      | undefined
    return row ? rowToTask(row) : null
  }

  findBySession(sessionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM task_queue WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as TaskRow[]
    return rows.map(rowToTask)
  }

  findPending(): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM task_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`)
      .get() as TaskRow | undefined
    return row ? rowToTask(row) : null
  }

  findRunning(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_queue WHERE status = 'running'`)
      .all() as TaskRow[]
    return rows.map(rowToTask)
  }

  update(id: string, input: UpdateTaskInput): Task | null {
    if (!this.findById(id)) return null

    const sets: string[] = []
    const values: unknown[] = []

    if (input.status !== undefined) {
      sets.push('status = ?')
      values.push(input.status)
    }
    if (input.progress !== undefined) {
      sets.push('progress = ?')
      values.push(input.progress)
    }
    if (input.error !== undefined) {
      sets.push('error = ?')
      values.push(input.error)
    }
    if (input.startedAt !== undefined) {
      sets.push('started_at = ?')
      values.push(input.startedAt)
    }
    if (input.completedAt !== undefined) {
      sets.push('completed_at = ?')
      values.push(input.completedAt)
    }

    if (sets.length === 0) return this.findById(id)

    values.push(id)

    this.db.prepare(`UPDATE task_queue SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    return this.findById(id)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM task_queue WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteNonCompletedForSession(sessionId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM task_queue WHERE session_id = ? AND status IN ('failed', 'cancelled', 'pending')`
      )
      .run(sessionId)
    return result.changes
  }

  cancelPendingForSession(sessionId: string): number {
    const result = this.db
      .prepare(
        `UPDATE task_queue SET status = 'cancelled', completed_at = ?
         WHERE session_id = ? AND status = 'pending'`
      )
      .run(new Date().toISOString(), sessionId)
    return result.changes
  }

  resetRunningToPending(): number {
    const result = this.db
      .prepare(
        `UPDATE task_queue SET status = 'pending', started_at = NULL, progress = 0
         WHERE status = 'running'`
      )
      .run()
    return result.changes
  }
}
