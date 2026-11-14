import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'

function migrateUpTo(db: Database.Database, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const current =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ??
    0
  for (const m of migrations.filter((m) => m.version > current && m.version <= version)) {
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
    })()
  }
}

// Epic #192 NFR 7: das Update behält alle Bestandsdaten; Migration 021 legt
// nur an (kein Rebuild von sessions/dossiers).
describe('Migration 021 — search index', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrateUpTo(db, 20)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 21', () => {
    expect(migrations.some((m) => m.version === 21)).toBe(true)
  })

  it('keeps every existing session, task, dossier assignment and recent item unchanged', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, summary, created_at, updated_at)
       VALUES ('s1', 'Alte Sitzung', 'audio', 'review', 'Zusammenfassung', 'a', 'b')`
    ).run()
    db.prepare(
      `INSERT INTO task_queue (id, session_id, type, status, progress, created_at)
       VALUES ('t1', 's1', 'anonymization', 'completed', 1, 'x')`
    ).run()
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm, created_at, updated_at)
       VALUES ('d1', 'Anna', 'Meier', 'anna', 'meier', 'x', 'x')`
    ).run()
    db.prepare(
      `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('s1', 'd1', 'x')`
    ).run()
    db.prepare(`INSERT INTO recent_items (session_id, opened_at) VALUES ('s1', 'x')`).run()
    const before = {
      sessions: db.prepare('SELECT * FROM sessions').all(),
      tasks: db.prepare('SELECT * FROM task_queue').all(),
      links: db.prepare('SELECT * FROM session_dossiers').all(),
      recent: db.prepare('SELECT * FROM recent_items').all()
    }

    migrateUpTo(db, 21)

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>
    expect(sessions.map(({ search_rev: _rev, ...rest }) => rest)).toEqual(before.sessions)
    expect(sessions[0].search_rev).toBe(0)
    expect(db.prepare('SELECT * FROM task_queue').all()).toEqual(before.tasks)
    expect(db.prepare('SELECT * FROM session_dossiers').all()).toEqual(before.links)
    expect(db.prepare('SELECT * FROM recent_items').all()).toEqual(before.recent)
    // Der Bestand hat noch keinen Index — die Textphase findet ihn über die fehlende Zeile
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_index_state').get()).toEqual({ n: 0 })
  })

  it('stores secure-delete on the FTS table and supports delete by rowid and trigram phrases', () => {
    migrateUpTo(db, 21)
    expect(db.prepare(`SELECT v FROM search_fts_config WHERE k = 'secure-delete'`).get()).toEqual({
      v: 1
    })
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
       VALUES ('s1', 't', 'audio', 'review', 'a', 'a')`
    ).run()
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO search_chunks (session_id, gen, field, ord, units, text)
         VALUES ('s1', 1, 'body', 0, '[]', 'Prüfungsangst')`
      )
      .run()
    db.prepare('INSERT INTO search_fts (rowid, norm) VALUES (?, ?)').run(
      lastInsertRowid,
      'pruefungsangst'
    )
    const match = (q: string): unknown[] =>
      db.prepare('SELECT rowid FROM search_fts WHERE search_fts MATCH ?').all(q)
    expect(match('"fungsangs"')).toHaveLength(1)
    expect(match('"angst" AND "pruef"')).toHaveLength(1)

    // Cascade: Sitzung weg → Abschnitt weg → Trigger löscht den FTS-Eintrag
    db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_chunks').get()).toEqual({ n: 0 })
    expect(match('"angst"')).toHaveLength(0)
  })

  it('limits recent queries to 1–200 characters and deduplicates by normalized key', () => {
    migrateUpTo(db, 21)
    const insert = db.prepare(
      'INSERT INTO search_recent_queries (query, query_norm, used_at) VALUES (?, ?, ?)'
    )
    expect(() => insert.run('', 'x', 'a')).toThrow()
    expect(() => insert.run('a'.repeat(201), 'y', 'a')).toThrow()
    insert.run('Angst', 'angst', 'a')
    expect(() => insert.run('ANGST', 'angst', 'b')).toThrow()
  })
})
