import type Database from 'better-sqlite3'
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
}
