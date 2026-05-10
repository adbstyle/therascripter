import { readFileSync } from 'fs'
import type Database from 'better-sqlite3'
import { countPlaceholderChips } from '../../shared/utils/countPlaceholderChips'
import type { TipTapDocument } from '../../shared/types/TipTapDocument'

interface LegacyRow {
  id: string
  anonymized_path: string
}

/**
 * Issue #102 — back-fills `anonymization_count` for review sessions that
 * reached 'review' before the column existed. Idempotent: only touches rows
 * where the count is still NULL. Failures on individual files are logged and
 * skipped so a single corrupt anonymized doc cannot block app startup.
 */
export function backfillAnonymizationCounts(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT id, anonymized_path FROM sessions
       WHERE status = 'review'
         AND anonymization_count IS NULL
         AND anonymized_path IS NOT NULL`
    )
    .all() as LegacyRow[]

  if (rows.length === 0) return 0

  const update = db.prepare('UPDATE sessions SET anonymization_count = ? WHERE id = ?')
  let updated = 0
  for (const row of rows) {
    try {
      const doc = JSON.parse(readFileSync(row.anonymized_path, 'utf-8')) as TipTapDocument
      const count = countPlaceholderChips(doc)
      update.run(count, row.id)
      updated++
    } catch (error) {
      console.error(
        `Anonymization-count backfill: skipping session ${row.id} — ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return updated
}
