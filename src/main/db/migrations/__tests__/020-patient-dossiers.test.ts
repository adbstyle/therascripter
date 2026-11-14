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

function insertDossier(db: Database.Database, id: string, externalIdNorm: string | null): void {
  db.prepare(
    `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
       external_id, external_id_norm, created_at, updated_at)
     VALUES (?, 'Anna', 'Meier', 'anna', 'meier', ?, ?, 'x', 'x')`
  ).run(id, externalIdNorm, externalIdNorm)
}

// Epic #192 / #204 PC 6: das Update behält alle Bestandsdaten.
describe('Migration 020 — patient dossiers', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // Stand direkt vor 020, damit «Bestandsdaten unverändert» nur 020 prüft
    migrateUpTo(db, 19)
  })

  afterEach(() => {
    db.close()
  })

  it('is registered as version 20', () => {
    expect(migrations.some((m) => m.version === 20)).toBe(true)
  })

  it('keeps every existing session, task and blocklist entry unchanged', () => {
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, transcript_path, summary, created_at, updated_at)
       VALUES ('s-audio', 'Alte Sitzung', 'audio', 'review', '/t/a.json', 'Zusammenfassung', 'a', 'a')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, pdf_path, created_at, updated_at, deleting_at)
       VALUES ('s-pdf', 'Bericht', 'pdf', 'error', '/p/x.pdf', 'b', 'b', 'c')`
    ).run()
    db.prepare(
      `INSERT INTO task_queue (id, session_id, type, status, progress, created_at)
       VALUES ('t1', 's-audio', 'anonymization', 'completed', 1, 'x')`
    ).run()
    db.prepare(
      `INSERT INTO blocklist (id, term, placeholder_type, created_at)
       VALUES ('b1', 'Hans', 'PERSON', 'x')`
    ).run()
    const sessionsBefore = db.prepare('SELECT * FROM sessions ORDER BY id').all()
    const tasksBefore = db.prepare('SELECT * FROM task_queue').all()
    const blocklistBefore = db.prepare('SELECT * FROM blocklist').all()

    migrateUpTo(db, 20)

    const sessionsAfter = db.prepare('SELECT * FROM sessions ORDER BY id').all() as Record<
      string,
      unknown
    >[]
    expect(sessionsAfter.map(({ document_date: _d, ...rest }) => rest)).toEqual(sessionsBefore)
    expect(sessionsAfter.every((r) => r.document_date === null)).toBe(true)
    expect(db.prepare('SELECT * FROM task_queue').all()).toEqual(tasksBefore)
    expect(db.prepare('SELECT * FROM blocklist').all()).toEqual(blocklistBefore)
    for (const table of ['dossiers', 'session_dossiers', 'recent_items']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  describe('after migrating', () => {
    beforeEach(() => {
      migrateUpTo(db, 20)
      db.prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
         VALUES ('s1', 'Sitzung', 'audio', 'review', 'x', 'x')`
      ).run()
    })

    it('enforces a unique normalized external id, but allows many without one', () => {
      insertDossier(db, 'd1', 'pd-1')
      insertDossier(db, 'd2', null)
      insertDossier(db, 'd3', null)
      expect(() => insertDossier(db, 'd4', 'pd-1')).toThrow(/UNIQUE/)
    })

    it('rejects malformed dates and inconsistent external id columns', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
               birth_date, created_at, updated_at)
             VALUES ('x', 'A', 'B', 'a', 'b', '03.02.1978', 'x', 'x')`
          )
          .run()
      ).toThrow(/CHECK/)
      expect(() =>
        db
          .prepare(
            `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
               external_id, created_at, updated_at)
             VALUES ('y', 'A', 'B', 'a', 'b', 'PD-1', 'x', 'x')`
          )
          .run()
      ).toThrow(/CHECK/)
      expect(() =>
        db.prepare("UPDATE sessions SET document_date = '2026-1-1' WHERE id = 's1'").run()
      ).toThrow(/CHECK/)
    })

    it('cascades assignments and recent items from dossiers and sessions', () => {
      insertDossier(db, 'd1', null)
      db.prepare(
        "INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('s1', 'd1', 'x')"
      ).run()
      db.prepare("INSERT INTO recent_items (dossier_id, opened_at) VALUES ('d1', 'x')").run()
      db.prepare("INSERT INTO recent_items (session_id, opened_at) VALUES ('s1', 'x')").run()

      db.prepare("DELETE FROM dossiers WHERE id = 'd1'").run()
      expect(db.prepare('SELECT COUNT(*) AS n FROM session_dossiers').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT session_id FROM recent_items').all()).toEqual([
        { session_id: 's1' }
      ])
      // Nie Cascade vom Dossier auf die Sitzung
      expect(db.prepare("SELECT id FROM sessions WHERE id = 's1'").get()).toEqual({ id: 's1' })

      db.prepare("DELETE FROM sessions WHERE id = 's1'").run()
      expect(db.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
    })

    it('requires exactly one target per recent item', () => {
      insertDossier(db, 'd1', null)
      expect(() => db.prepare("INSERT INTO recent_items (opened_at) VALUES ('x')").run()).toThrow(
        /CHECK/
      )
      expect(() =>
        db
          .prepare(
            "INSERT INTO recent_items (dossier_id, session_id, opened_at) VALUES ('d1', 's1', 'x')"
          )
          .run()
      ).toThrow(/CHECK/)
    })

    // Risiko aus dem Bauplan: ein künftiger Table-Rebuild von sessions.
    // Befund: defer_foreign_keys schützt NICHT (es verschiebt nur Prüfungen,
    // nicht ON-DELETE-Aktionen). Nur foreign_keys = OFF ausserhalb der
    // Transaktion lässt Zuordnungen und «Zuletzt»-Einträge überleben — siehe
    // Regel-Kommentar in migrations/index.ts.
    function rebuildSessions(mode: 'fk-on' | 'defer' | 'fk-off'): void {
      const { sql } = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() as { sql: string }
      const createNew = sql.replace(/^CREATE TABLE\s+"?sessions"?/i, 'CREATE TABLE sessions_new')
      if (mode === 'fk-off') db.pragma('foreign_keys = OFF')
      try {
        db.transaction(() => {
          if (mode === 'defer') db.exec('PRAGMA defer_foreign_keys = ON;')
          db.exec(`
            ${createNew};
            INSERT INTO sessions_new SELECT * FROM sessions;
            DROP TABLE sessions;
            ALTER TABLE sessions_new RENAME TO sessions;
          `)
          expect(db.pragma('foreign_key_check')).toEqual([])
        })()
      } finally {
        db.pragma('foreign_keys = ON')
      }
    }

    function seedReferences(): void {
      insertDossier(db, 'd1', null)
      db.prepare(
        "INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('s1', 'd1', 'x')"
      ).run()
      db.prepare("INSERT INTO recent_items (session_id, opened_at) VALUES ('s1', 'x')").run()
    }

    function referenceCounts(): { assignments: number; recent: number } {
      return {
        assignments: (
          db.prepare('SELECT COUNT(*) AS n FROM session_dossiers').get() as { n: number }
        ).n,
        recent: (db.prepare('SELECT COUNT(*) AS n FROM recent_items').get() as { n: number }).n
      }
    }

    it('keeps assignments and recent items through a sessions rebuild with foreign_keys off', () => {
      seedReferences()
      rebuildSessions('fk-off')
      expect(referenceCounts()).toEqual({ assignments: 1, recent: 1 })
      expect(db.prepare('SELECT session_id, dossier_id FROM session_dossiers').all()).toEqual([
        { session_id: 's1', dossier_id: 'd1' }
      ])
    })

    it('a rebuild with defer_foreign_keys still wipes them (the cascade is an action, not a check)', () => {
      seedReferences()
      rebuildSessions('defer')
      expect(referenceCounts()).toEqual({ assignments: 0, recent: 0 })
    })

    it('control: a plain rebuild with foreign keys on wipes them', () => {
      seedReferences()
      rebuildSessions('fk-on')
      expect(referenceCounts()).toEqual({ assignments: 0, recent: 0 })
    })
  })
})
