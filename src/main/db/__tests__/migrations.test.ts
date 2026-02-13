import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Migration } from '../migrations'

function loadMigrations(): Migration[] {
  const sql = readFileSync(
    join(__dirname, '..', 'migrations', '001-initial-schema.sql'),
    'utf-8'
  )
  return [{ version: 1, sql }]
}

function runMigrations(database: Database.Database, migrations: Migration[]): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `)

  const row = database
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined
  const currentVersion = row?.version ?? 0

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    })()
  }
}

describe('migrations', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  it('applies initial migration and records version', () => {
    const migrations = loadMigrations()
    runMigrations(db, migrations)

    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as {
      version: number
    }
    expect(row.version).toBe(1)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const tableNames = tables.map((t) => t.name)

    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('blocklist')
    expect(tableNames).toContain('task_queue')
    expect(tableNames).toContain('model_registry')
    expect(tableNames).toContain('schema_version')
  })

  it('is idempotent — running twice does not duplicate schema_version rows', () => {
    const migrations = loadMigrations()

    runMigrations(db, migrations)
    runMigrations(db, migrations)

    const rows = db.prepare('SELECT * FROM schema_version').all()
    expect(rows).toHaveLength(1)
  })

  it('skips already-applied migrations', () => {
    const migrations = loadMigrations()
    runMigrations(db, migrations)

    const extendedMigrations = [
      ...migrations,
      { version: 2, sql: 'CREATE TABLE test_table (id TEXT PRIMARY KEY)' }
    ]
    runMigrations(db, extendedMigrations)

    const rows = db.prepare('SELECT * FROM schema_version ORDER BY version').all() as {
      version: number
    }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].version).toBe(1)
    expect(rows[1].version).toBe(2)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('rolls back failed migration without recording version', () => {
    const migrations = loadMigrations()
    runMigrations(db, migrations)

    const badMigrations = [
      ...migrations,
      { version: 2, sql: 'CREATE TABLE good_table (id TEXT); INSERT INTO nonexistent VALUES (1)' }
    ]

    expect(() => runMigrations(db, badMigrations)).toThrow()

    const rows = db.prepare('SELECT * FROM schema_version').all()
    expect(rows).toHaveLength(1)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'")
      .all()
    expect(tables).toHaveLength(0)
  })
})
