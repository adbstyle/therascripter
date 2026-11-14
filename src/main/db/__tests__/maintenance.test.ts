import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))

import { initDatabase, closeDatabase, getDatabase } from '../connection'
import { migrations } from '../migrations'
import { SECURE_DELETE_VACUUM, walCheckpointTruncate } from '../maintenance'

const MARKER = 'ZQX-Bestand-Klarname-4417'

function fileContains(path: string, needle: string): boolean {
  if (!existsSync(path)) return false
  return readFileSync(path).includes(Buffer.from(needle, 'utf-8'))
}

/** A database as the version before #202 left it: up to migration 17, no secure_delete. */
function createLegacyDatabase(path: string): void {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('secure_delete = OFF')
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)')
  for (const m of migrations.filter((m) => m.version <= 17)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
  const insert = db.prepare(
    `INSERT INTO sessions (id, title, type, status, entity_map, created_at, updated_at)
     VALUES (?, ?, 'audio', 'review', ?, 'x', 'x')`
  )
  // A session whose entity map was overwritten later …
  insert.run('kept', 'Bleibt', JSON.stringify({ e1: { original: `${MARKER} alt` } }))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare('UPDATE sessions SET entity_map = ? WHERE id = ?').run(
    '{"e1":{"original":"neu"}}',
    'kept'
  )
  // … and a session deleted by the old version
  insert.run('gone', `Sitzung ${MARKER}`, JSON.stringify({ e1: { original: MARKER } }))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare("DELETE FROM sessions WHERE id = 'gone'").run()
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}

describe('startup maintenance (Issue #202)', () => {
  let dbPath: string

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'maintenance-test-'))
    dbPath = join(home.path, 'therascript.db')
  })

  afterEach(() => {
    closeDatabase()
    vi.restoreAllMocks()
    rmSync(home.path, { recursive: true, force: true })
  })

  it('removes old content left in free space by the version before secure_delete', () => {
    createLegacyDatabase(dbPath)
    // Control: the old content is readable in the file before the update
    expect(fileContains(dbPath, MARKER)).toBe(true)

    initDatabase(dbPath)

    expect(fileContains(dbPath, MARKER)).toBe(false)
    expect(fileContains(`${dbPath}-wal`, MARKER)).toBe(false)
    const kept = getDatabase()
      .prepare("SELECT entity_map FROM sessions WHERE id = 'kept'")
      .get() as {
      entity_map: string
    }
    expect(kept.entity_map).toBe('{"e1":{"original":"neu"}}')
  })

  it('runs the VACUUM exactly once, also across restarts', () => {
    createLegacyDatabase(dbPath)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const vacuumLogs = (): number =>
      log.mock.calls.filter((c) => String(c[0]).includes('VACUUM')).length

    initDatabase(dbPath)
    const doneAt = (
      getDatabase()
        .prepare('SELECT done_at FROM app_maintenance WHERE task = ?')
        .get(SECURE_DELETE_VACUUM) as { done_at: string | null }
    ).done_at
    expect(doneAt).not.toBeNull()
    expect(vacuumLogs()).toBe(1)

    closeDatabase()
    initDatabase(dbPath)

    expect(vacuumLogs()).toBe(1)
    const after = getDatabase()
      .prepare('SELECT done_at FROM app_maintenance WHERE task = ?')
      .get(SECURE_DELETE_VACUUM) as { done_at: string }
    expect(after.done_at).toBe(doneAt)
  })

  it('checkpoints the WAL at every start (closes «crash between commit and checkpoint»)', () => {
    initDatabase(dbPath)
    closeDatabase()
    // Leave WAL content behind like a crash would: write without checkpoint,
    // keep the connection from checkpointing on close
    const raw = new Database(dbPath)
    raw.pragma('wal_autocheckpoint = 0')
    raw
      .prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
         VALUES ('w', 'WAL', 'audio', 'review', 'x', 'x')`
      )
      .run()
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)

    // The writing connection stays open (so its close does not checkpoint);
    // initDatabase must still empty the WAL
    initDatabase(dbPath)

    expect(statSync(`${dbPath}-wal`).size).toBe(0)
    raw.close()
  })

  it('walCheckpointTruncate reports a blocked checkpoint (busy)', () => {
    initDatabase(dbPath)
    const db = getDatabase()
    db.pragma('busy_timeout = 0') // test only: report busy instead of waiting 5 s
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
       VALUES ('r', 'R', 'audio', 'review', 'x', 'x')`
    ).run()
    const reader = new Database(dbPath)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM sessions').get()
    db.prepare("UPDATE sessions SET title = 'R2' WHERE id = 'r'").run()

    expect(walCheckpointTruncate(db)).toBe(false)

    reader.exec('COMMIT')
    reader.close()
    expect(walCheckpointTruncate(db)).toBe(true)
  })
})
