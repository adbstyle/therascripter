import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../index'
import { SessionRepository } from '../../repositories/SessionRepository'

function migrateUpTo(db: Database.Database, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const current =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ??
    0
  for (const m of migrations.filter((m) => m.version > current && m.version <= version)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

// Issue #202, Postcondition 3: the update keeps every session with all data.
describe('Migration 017 — deleting_at', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrateUpTo(db, 16)
  })

  it('keeps every existing session, old or new, with all its data and tasks', () => {
    const old = new Date()
    old.setDate(old.getDate() - 120)
    const entityMap = JSON.stringify({
      e1: { original: 'Hans', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
    })
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, transcript_path, anonymized_path, entity_map,
         summary, review_at, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'old-review',
      'Alte Sitzung',
      'audio',
      'review',
      '/t/old.json',
      '/a/old.json',
      entityMap,
      'Zusammenfassung',
      old.toISOString(),
      321,
      old.toISOString(),
      old.toISOString()
    )
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, pdf_path, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('pdf-error', 'Bericht', 'pdf', 'error', '/p/x.pdf', 'Fehler', 'x', 'x')
    db.prepare(
      `INSERT INTO task_queue (id, session_id, type, status, progress, created_at)
       VALUES ('t1', 'old-review', 'anonymization', 'completed', 1, 'x')`
    ).run()
    const before = db.prepare('SELECT * FROM sessions ORDER BY id').all()

    migrateUpTo(db, 17)

    const after = db.prepare('SELECT * FROM sessions ORDER BY id').all() as Record<
      string,
      unknown
    >[]
    expect(after.map(({ deleting_at: _d, ...rest }) => rest)).toEqual(before)
    expect(after.every((r) => r.deleting_at === null)).toBe(true)
    expect(db.prepare('SELECT id FROM task_queue').all()).toEqual([{ id: 't1' }])

    // The repository targets the latest schema
    migrateUpTo(db, Number.MAX_SAFE_INTEGER)
    const repo = new SessionRepository(db)
    expect(repo.findAll().map((s) => s.id)).toEqual(['pdf-error', 'old-review'])
    expect(repo.findById('old-review')?.entityMap?.e1.original).toBe('Hans')
  })
})
