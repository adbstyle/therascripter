import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { migrations as productionMigrations, type Migration } from '../migrations'

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/home' }
}))

// Tests the real runner from connection.ts (no inline copy).
import { runMigrations } from '../connection'

function loadMigrations(): Migration[] {
  const sql = readFileSync(join(__dirname, '..', 'migrations', '001-initial-schema.sql'), 'utf-8')
  return [{ version: 1, sql }]
}

function appliedVersions(db: Database.Database): number[] {
  return (
    db.prepare('SELECT version FROM schema_version ORDER BY version').all() as {
      version: number
    }[]
  ).map((r) => r.version)
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

  // Review #217: a version merged after a higher one must still be applied.
  describe('versions missing below the maximum', () => {
    it('back-fills 19 into a database that has 1..18 and 20', () => {
      const without19 = productionMigrations.filter((m) => m.version !== 19)
      runMigrations(db, without19)
      expect(appliedVersions(db)).not.toContain(19)
      expect(
        (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[])
          .map((c) => c.name)
          .includes('title_plain')
      ).toBe(false)

      runMigrations(db, productionMigrations)

      expect(appliedVersions(db)).toEqual(productionMigrations.map((m) => m.version))
      expect(
        (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[])
          .map((c) => c.name)
          .includes('title_plain')
      ).toBe(true)
    })

    it('leaves a fully migrated database unchanged and never runs a version twice', () => {
      runMigrations(db, productionMigrations)
      const schemaBefore = db
        .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name')
        .all()
      const versionsBefore = appliedVersions(db)

      // A re-run of any applied migration would fail (CREATE TABLE without IF NOT EXISTS)
      expect(() => runMigrations(db, productionMigrations)).not.toThrow()

      expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
        schemaBefore
      )
      expect(appliedVersions(db)).toEqual(versionsBefore)
    })

    it('applies pending migrations in ascending order, whatever the list order', () => {
      runMigrations(db, loadMigrations())
      const order: number[] = []
      const log = (v: number): Migration => ({
        version: v,
        sql: `CREATE TABLE IF NOT EXISTS run_log (v INTEGER); INSERT INTO run_log VALUES (${v});`
      })
      runMigrations(db, [log(5), log(3), log(4)])
      for (const r of db.prepare('SELECT v FROM run_log ORDER BY rowid').all() as { v: number }[])
        order.push(r.v)
      expect(order).toEqual([3, 4, 5])
    })
  })
})
