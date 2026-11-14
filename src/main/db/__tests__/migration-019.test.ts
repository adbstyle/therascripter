import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrations } from '../migrations'
import { runStartupMaintenance, PLACEHOLDER_PLAIN_BACKFILL } from '../maintenance'

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

describe('migrations array', () => {
  it('has unique, ascending, gap-free versions starting at 1 (no gap, no double use)', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toEqual(versions.map((_, i) => i + 1))
  })
})

const entry = (placeholder: unknown, original: unknown) => ({
  placeholder,
  original,
  type: 'PERSON',
  source: 'ner'
})

const ENTITY_MAP = JSON.stringify({
  'person-1': entry('[PERSON 1]', 'Ruth Gerber'),
  'ort-1': { ...entry('[ORT 1]', 'Bern'), type: 'ORT' },
  'person-2a': entry('[PERSON 2]', 'Max'),
  'person-2b': entry('[PERSON 2]', 'Moritz'),
  'datum-1': entry('[DATUM 1]', ' ')
})

describe('migration 019 — placeholder snapshots (#203)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateUpTo(db, 18)
  })

  afterEach(() => db.close())

  const insert = (id: string, title: string, summary: string | null, entityMap: string | null) =>
    db
      .prepare(
        `INSERT INTO sessions (id, title, type, status, summary, entity_map, created_at, updated_at)
         VALUES (?, ?, 'audio', 'review', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(id, title, summary, entityMap)

  const row = (id: string) =>
    db
      .prepare(
        `SELECT title_entity_snapshot AS t, summary_entity_snapshot AS s,
                title_plain AS tp, summary_plain AS sp FROM sessions WHERE id = ?`
      )
      .get(id) as { t: string | null; s: string | null; tp: string | null; sp: string | null }

  it('records the current, unambiguous meaning of the tokens in title and summary', () => {
    insert(
      's1',
      'Gespräch mit [PERSON 1]',
      '[PERSON 1] aus [ORT 1] traf [PERSON 2] am [DATUM 1].',
      ENTITY_MAP
    )
    migrateUpTo(db, 19)

    const { t, s } = row('s1')
    expect(JSON.parse(t!)).toEqual({ '[PERSON 1]': 'Ruth Gerber' })
    // [PERSON 2] is ambiguous and [DATUM 1] has no original: both left out
    expect(JSON.parse(s!)).toEqual({ '[PERSON 1]': 'Ruth Gerber', '[ORT 1]': 'Bern' })
  })

  it('never fails on malformed legacy data — it leaves the snapshot NULL instead', () => {
    const bigMap: Record<string, unknown> = {}
    for (let i = 1; i <= 5000; i++) bigMap[`person-${i}`] = entry(`[PERSON ${i}]`, `Name ${i}`)
    const evil: Array<[string, string | null]> = [
      ['strings', JSON.stringify({ a: 'abc', b: '[PERSON 1]' })],
      ['numbers', JSON.stringify({ a: 3, b: 4.5 })],
      ['nulls', JSON.stringify({ a: null })],
      ['arrays', JSON.stringify({ a: [1, '[PERSON 1]'], b: [] })],
      ['nested', JSON.stringify({ a: { placeholder: { x: 1 }, original: ['Ruth'] } })],
      ['wrongTypes', JSON.stringify({ a: entry(1, 'Ruth'), b: entry('[PERSON 1]', 2) })],
      ['invalidJson', '{kaputt'],
      ['topArray', '[{"placeholder":"[PERSON 1]","original":"Ruth"}]'],
      ['topString', '"[PERSON 1]"'],
      ['sqlNull', null],
      ['empty', '{}'],
      [
        'mixed',
        JSON.stringify({ a: 'abc', b: entry('[PERSON 1]', 'Ruth Gerber'), c: null, d: [1] })
      ]
    ]
    for (const [id, map] of evil) insert(id, `[PERSON 1] ${id}`, '[PERSON 1] erzählt.', map)
    insert('big', '[PERSON 4999]', '[PERSON 1] und [PERSON 5000]', JSON.stringify(bigMap))

    expect(() => migrateUpTo(db, 19)).not.toThrow()

    for (const [id] of evil.filter(([id]) => id !== 'mixed')) {
      expect(row(id), id).toEqual({ t: null, s: null, tp: null, sp: null })
    }
    expect(JSON.parse(row('mixed').s!)).toEqual({ '[PERSON 1]': 'Ruth Gerber' })
    expect(JSON.parse(row('big').t!)).toEqual({ '[PERSON 4999]': 'Name 4999' })
    expect(JSON.parse(row('big').s!)).toEqual({
      '[PERSON 1]': 'Name 1',
      '[PERSON 5000]': 'Name 5000'
    })
  })

  it('leaves texts without tokens alone', () => {
    insert('plain', 'Aufnahme 14.02.2026', 'Ohne Platzhalter.', ENTITY_MAP)
    migrateUpTo(db, 19)
    expect(row('plain')).toEqual({ t: null, s: null, tp: null, sp: null })
  })

  it('the startup maintenance computes the stored Klartext once', () => {
    insert('s1', 'Gespräch mit [PERSON 1]', '[PERSON 1] traf [PERSON 2].', ENTITY_MAP)
    insert('bad', '[PERSON 1]', null, '{"a":"abc"}')
    migrateUpTo(db, 19)

    runStartupMaintenance(db)

    expect(row('s1')).toMatchObject({
      tp: 'Gespräch mit Ruth Gerber',
      sp: 'Ruth Gerber traf [PERSON 2].'
    })
    expect(row('bad')).toMatchObject({ tp: null, sp: null })
    const task = db
      .prepare('SELECT done_at FROM app_maintenance WHERE task = ?')
      .get(PLACEHOLDER_PLAIN_BACKFILL) as { done_at: string | null }
    expect(task.done_at).not.toBeNull()
  })
})
