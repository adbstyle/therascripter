import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../migrations'

/** Applies the pending migrations up to (and including) `version`, like the runner. */
function migrateUpTo(db: Database.Database, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)')
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ??
    0
  for (const m of migrations.filter((m) => m.version > current && m.version <= version)) {
    db.exec(m.sql)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
  }
}

const ENTITY_MAP = JSON.stringify({
  'person-1': { original: 'Ruth Gerber', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' },
  'ort-1': { original: 'Bern', placeholder: '[ORT 1]', type: 'ORT', source: 'ner' },
  'person-2a': { original: 'Max', placeholder: '[PERSON 2]', type: 'PERSON', source: 'ner' },
  'person-2b': { original: 'Moritz', placeholder: '[PERSON 2]', type: 'PERSON', source: 'manual' },
  'datum-1': { original: ' ', placeholder: '[DATUM 1]', type: 'DATUM', source: 'ner' }
})

describe('migration 018 — placeholder snapshots (#203)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateUpTo(db, 16)
  })

  afterEach(() => db.close())

  const insert = (id: string, title: string, summary: string | null, entityMap: string | null) =>
    db
      .prepare(
        `INSERT INTO sessions (id, title, type, status, summary, entity_map, created_at, updated_at)
         VALUES (?, ?, 'audio', 'review', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(id, title, summary, entityMap)

  const snapshots = (id: string) =>
    db
      .prepare(
        'SELECT title_entity_snapshot AS t, summary_entity_snapshot AS s FROM sessions WHERE id = ?'
      )
      .get(id) as { t: string | null; s: string | null }

  it('records the current, unambiguous meaning of the tokens in title and summary', () => {
    insert(
      's1',
      'Gespräch mit [PERSON 1]',
      '[PERSON 1] aus [ORT 1] traf [PERSON 2] am [DATUM 1].',
      ENTITY_MAP
    )
    migrateUpTo(db, 18)

    const { t, s } = snapshots('s1')
    expect(JSON.parse(t!)).toEqual({ '[PERSON 1]': 'Ruth Gerber' })
    // [PERSON 2] is ambiguous and [DATUM 1] has no original: both left out
    expect(JSON.parse(s!)).toEqual({ '[PERSON 1]': 'Ruth Gerber', '[ORT 1]': 'Bern' })
  })

  it('leaves texts without tokens, sessions without EntityMap and corrupt maps alone', () => {
    insert('plain', 'Aufnahme 14.02.2026', 'Ohne Platzhalter.', ENTITY_MAP)
    insert('nomap', '[PERSON 1]', '[PERSON 1]', null)
    insert('corrupt', '[PERSON 1]', '[PERSON 1]', '{kaputt')
    migrateUpTo(db, 18)

    expect(snapshots('plain')).toEqual({ t: null, s: null })
    expect(snapshots('nomap')).toEqual({ t: null, s: null })
    expect(snapshots('corrupt')).toEqual({ t: null, s: null })
  })
})
