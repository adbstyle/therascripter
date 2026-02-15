import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type { PlaceholderType } from '../../../shared/types'
import type { BlocklistEntry } from '../../../shared/types/NerTypes'

interface BlocklistRow {
  id: string
  term: string
  placeholder_type: PlaceholderType
  created_at: string
}

function rowToEntry(row: BlocklistRow): BlocklistEntry {
  return {
    id: row.id,
    term: row.term,
    placeholderType: row.placeholder_type,
    createdAt: row.created_at
  }
}

export class BlocklistRepository {
  constructor(private db: Database.Database) {}

  findAll(): BlocklistEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM blocklist ORDER BY created_at ASC')
      .all() as BlocklistRow[]
    return rows.map(rowToEntry)
  }

  findById(id: string): BlocklistEntry | null {
    const row = this.db.prepare('SELECT * FROM blocklist WHERE id = ?').get(id) as
      | BlocklistRow
      | undefined
    return row ? rowToEntry(row) : null
  }

  create(term: string, placeholderType: PlaceholderType): BlocklistEntry {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.db
      .prepare(
        'INSERT INTO blocklist (id, term, placeholder_type, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(id, term, placeholderType, now)

    return this.findById(id)!
  }

  update(id: string, term: string, placeholderType: PlaceholderType): BlocklistEntry | null {
    if (!this.findById(id)) return null

    this.db
      .prepare('UPDATE blocklist SET term = ?, placeholder_type = ? WHERE id = ?')
      .run(term, placeholderType, id)

    return this.findById(id)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM blocklist WHERE id = ?').run(id)
    return result.changes > 0
  }
}
