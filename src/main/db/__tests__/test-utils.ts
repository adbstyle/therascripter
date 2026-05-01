import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const migrationsDir = join(__dirname, '..', 'migrations')

/**
 * Applies all .sql migration files in the migrations directory in lexical order.
 * Used by tests that need a fully-migrated in-memory schema. Stays in sync with
 * production migrations automatically — no need to update on every new migration.
 */
export function applyTestSchema(db: Database.Database): void {
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of sqlFiles) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf-8'))
  }
}
