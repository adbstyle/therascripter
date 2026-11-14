import type Database from 'better-sqlite3'
import type { EntityMap } from '../../shared/types'
import {
  parsePlaceholderSnapshot,
  resolvePlaceholders
} from '../../shared/utils/resolvePlaceholders'

/**
 * Issue #203 — Klartext title/summary, computed when a session is WRITTEN
 * and stored in `title_plain` / `summary_plain`. The session list reads only
 * these columns: it never parses an entity_map and never sees a snapshot
 * (token → clear name).
 */

interface PlainSourceRow {
  title: string
  summary: string | null
  entity_map: string | null
  title_entity_snapshot: string | null
  summary_entity_snapshot: string | null
}

export interface PlainTexts {
  /** NULL: the title holds no resolvable token — the list shows `title`. */
  titlePlain: string | null
  summaryPlain: string | null
}

function parseEntityMap(json: string | null): EntityMap | null {
  if (!json) return null
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as EntityMap) : null
  } catch {
    return null
  }
}

/** Resolved text, or NULL when nothing changes (no clear name to store). */
function plainOrNull(
  text: string | null,
  entityMap: () => EntityMap | null,
  snapshotJson: string | null
): string | null {
  if (!text || !text.includes('[')) return null
  const snapshot = parsePlaceholderSnapshot(snapshotJson)
  if (!snapshot) return null
  const plain = resolvePlaceholders(text, entityMap(), snapshot)
  return plain === text ? null : plain
}

export function computePlainTexts(row: PlainSourceRow): PlainTexts {
  let map: EntityMap | null | undefined
  const entityMap = (): EntityMap | null =>
    map === undefined ? (map = parseEntityMap(row.entity_map)) : map
  return {
    titlePlain: plainOrNull(row.title, entityMap, row.title_entity_snapshot),
    summaryPlain: plainOrNull(row.summary, entityMap, row.summary_entity_snapshot)
  }
}

const SOURCE_COLUMNS = 'title, summary, entity_map, title_entity_snapshot, summary_entity_snapshot'

/** Recomputes the stored Klartext of one session from its current row. */
export function refreshPlainTexts(db: Database.Database, id: string): void {
  const row = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sessions WHERE id = ?`).get(id) as
    | PlainSourceRow
    | undefined
  if (!row) return
  const { titlePlain, summaryPlain } = computePlainTexts(row)
  db.prepare('UPDATE sessions SET title_plain = ?, summary_plain = ? WHERE id = ?').run(
    titlePlain,
    summaryPlain,
    id
  )
}

/**
 * One-time backfill after migration 019 for existing sessions. Never throws
 * for a single row: a row that cannot be resolved keeps NULL (= placeholders).
 */
export function backfillPlainTexts(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT id, ${SOURCE_COLUMNS} FROM sessions
       WHERE title_entity_snapshot IS NOT NULL OR summary_entity_snapshot IS NOT NULL`
    )
    .all() as Array<PlainSourceRow & { id: string }>
  const write = db.prepare('UPDATE sessions SET title_plain = ?, summary_plain = ? WHERE id = ?')
  let written = 0
  for (const row of rows) {
    try {
      const { titlePlain, summaryPlain } = computePlainTexts(row)
      write.run(titlePlain, summaryPlain, row.id)
      written++
    } catch (error) {
      console.error(`[DB] Klartext für Sitzung ${row.id} nicht berechnet:`, error)
    }
  }
  return written
}
