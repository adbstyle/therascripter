import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { chmodSync, existsSync, mkdirSync } from 'fs'
import { migrations } from './migrations'

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

    runMigrations(db)
  } catch (error) {
    db.close()
    db = null
    throw error
  }

  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)

  const row = database.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  const currentVersion = row?.version ?? 0

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    })()
  }
}
