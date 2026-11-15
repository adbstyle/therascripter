import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { chmodSync, existsSync, mkdirSync } from 'fs'
import { migrations, type Migration } from './migrations'
import { runStartupMaintenance } from './maintenance'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function getDataDir(): string {
  return join(app.getPath('home'), '.therascript')
}

export function initDatabase(dbPath?: string): Database.Database {
  if (db) return db

  const dataDir = getDataDir()
  const dirs = [
    join(dataDir, 'data'),
    join(dataDir, 'audio'),
    join(dataDir, 'transcripts'),
    join(dataDir, 'anonymized'),
    join(dataDir, 'diarization'),
    join(dataDir, 'pdf'),
    join(dataDir, 'extracted'),
    join(dataDir, 'recovery'),
    join(dataDir, 'models'),
    join(dataDir, 'models', 'asr'),
    join(dataDir, 'models', 'diarization'),
    join(dataDir, 'models', 'ner')
  ]

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } else {
      chmodSync(dir, 0o700)
    }
  }

  const resolvedPath = dbPath ?? join(dataDir, 'data', 'therascript.db')
  db = new Database(resolvedPath)

  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = NORMAL')
    db.pragma('temp_store = MEMORY')
    // Issue #202: gelöschte Inhalte (Sitzungen, Pseudonymisierung samt
    // Originaltexten) werden in der Datei mit Nullen überschrieben statt als
    // freie Seiten liegen zu bleiben. Gilt pro Verbindung, nicht persistent —
    // deshalb bei jedem Öffnen. Zusammen mit dem WAL-Checkpoint nach jedem
    // Löschen (SessionService) bleibt keine Kopie in .db oder -wal zurück.
    db.pragma('secure_delete = ON')

    runMigrations(db)
    runStartupMaintenance(db)
  } catch (error) {
    db.close()
    db = null
    throw error
  }

  return db
}

/** Ob die Datenbank offen ist (nach der Deinstallation z. B. nicht mehr). */
export function isDatabaseOpen(): boolean {
  return db !== null
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Applies every migration whose version is not yet recorded in schema_version,
 * in ascending order, each in its own transaction (Epic #192 review of #217).
 *
 * Earlier versions only ran migrations ABOVE the highest recorded version. A
 * migration number that was merged later than a higher one (e.g. 019 landing
 * after a database already had 020) was then skipped forever. Checking each
 * version individually closes that gap; already applied versions never run
 * twice.
 */
export function runMigrations(
  database: Database.Database,
  list: readonly Migration[] = migrations
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (database.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
      (r) => r.version
    )
  )

  const pending = list.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    })()
  }
}
