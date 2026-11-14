import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, closeDatabase, runMigrations } from '../connection'
import { migrations } from '../migrations'
import { PLACEHOLDER_PLAIN_BACKFILL, SECURE_DELETE_VACUUM } from '../maintenance'
import { SearchIndexService } from '../../search/SearchIndexService'
import { SearchService } from '../../search/SearchService'

// Epic #192 Abschluss-Check: das Update von einer Datenbank im Stand von `main`
// (Schema-Version 16, vor dem Epic) auf den Endstand des Epics.
//  1. Ein frisch angelegtes und ein von Version 16 migriertes Schema sind gleich.
//  2. Realistische Bestandsdaten (Sitzungen in allen Zuständen, Sperrliste,
//     Tasks) überstehen Migrationen 017–021 und die einmalige Wartung
//     (Klartext-Backfill, VACUUM) unverändert (#202 PC 3, Epic NFR 7), und die
//     Aufbereitung des Bestands für die Suche startet ohne Zutun (#210 AK 1).

const MAIN_SCHEMA_VERSION = 16

/** Eine Datenbank, wie sie die Version vor dem Epic hinterlässt (WAL, ohne secure_delete). */
function createVersion16Database(path: string, seed?: (db: Database.Database) => void): void {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Derselbe Runner wie in main (connection.ts): legt schema_version gleich an
  runMigrations(
    db,
    migrations.filter((m) => m.version <= MAIN_SCHEMA_VERSION)
  )
  seed?.(db)
  db.close()
}

function schemaOf(db: Database.Database): unknown {
  const objects = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all() as { type: string; name: string }[]
  const columns = objects
    .filter((o) => o.type === 'table')
    .map((o) => ({ table: o.name, columns: db.prepare(`PRAGMA table_xinfo('${o.name}')`).all() }))
  const foreignKeys = objects
    .filter((o) => o.type === 'table')
    .map((o) => ({ table: o.name, fks: db.prepare(`PRAGMA foreign_key_list('${o.name}')`).all() }))
  return { objects, columns, foreignKeys }
}

const ENTITY_MAP = JSON.stringify({
  e1: { original: 'Anna Brändli', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' },
  e2: { original: 'Winterthur', placeholder: '[ORT 1]', type: 'ORT', source: 'ner' }
})

const STATUSES = ['recording', 'queued', 'processing', 'error', 'review'] as const

function seedRealisticStock(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO sessions (id, title, type, status, audio_path, transcript_path, anonymized_path,
       pdf_path, entity_map, error_message, created_at, updated_at, diarization_path, review_at,
       aligned_transcript_path, extracted_path, word_count, summary, summary_model_id,
       summarized_at, planned_steps, retry_count, pdf_has_scanned_pages, processed_with_models,
       anonymization_count)
     VALUES (@id, @title, @type, @status, @audio, @transcript, @anonymized, @pdf, @entityMap,
       @error, @created, @updated, @diar, @reviewAt, @aligned, @extracted, @words, @summary,
       @summaryModel, @summarizedAt, @planned, @retry, @scanned, @models, @anonCount)`
  )
  STATUSES.forEach((status, i) => {
    for (const type of ['audio', 'pdf'] as const) {
      const id = `${type}-${status}`
      const done = status === 'review'
      insert.run({
        id,
        title: done ? 'Gespräch mit [PERSON 1] in [ORT 1]' : `Sitzung ${i}`,
        type,
        status,
        audio: type === 'audio' ? `/data/audio/${id}.wav` : null,
        transcript: done && type === 'audio' ? `/data/transcripts/${id}.json` : null,
        anonymized: done ? `/data/anonymized/${id}.json` : null,
        pdf: type === 'pdf' ? `/data/pdf/${id}.pdf` : null,
        entityMap: done ? ENTITY_MAP : null,
        error: status === 'error' ? 'Verarbeitung fehlgeschlagen' : null,
        // älter als 30 Tage: darf nach dem Update nicht verschwinden (#202 AK 1)
        created: `2025-0${i + 1}-15T09:00:00.000Z`,
        updated: `2025-0${i + 1}-15T10:00:00.000Z`,
        diar: done && type === 'audio' ? `/data/diarization/${id}.rttm` : null,
        reviewAt: done ? `2025-0${i + 1}-15T10:00:00.000Z` : null,
        aligned: done && type === 'audio' ? `/data/transcripts/${id}.aligned.json` : null,
        extracted: done && type === 'pdf' ? `/data/extracted/${id}.json` : null,
        words: done ? 1234 : null,
        summary: done ? '[PERSON 1] berichtet über den Umzug nach [ORT 1].' : null,
        summaryModel: done ? 'gemma-4-e2b' : null,
        summarizedAt: done ? '2025-05-15T10:05:00.000Z' : null,
        planned: status === 'processing' ? '["diarization","transcription"]' : null,
        retry: status === 'error' ? 1 : 0,
        scanned: type === 'pdf' ? 0 : null,
        models: done ? '{"transcription":"whisper"}' : null,
        anonCount: done ? 2 : null
      })
    }
  })
  const task = db.prepare(
    `INSERT INTO task_queue (id, session_id, type, status, progress, error, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, '2025-05-15T09:00:00.000Z', ?)`
  )
  task.run('t1', 'audio-processing', 'diarization', 'running', 0.4, null, 1)
  task.run('t2', 'audio-processing', 'transcription', 'pending', 0, null, 0)
  task.run('t3', 'audio-queued', 'diarization', 'pending', 0, null, 0)
  task.run('t4', 'audio-error', 'transcription', 'failed', 0.2, 'Zeitüberschreitung', 2)
  task.run('t5', 'audio-review', 'anonymization', 'completed', 1, null, 0)
  task.run('t6', 'pdf-review', 'summarization', 'cancelled', 0, null, 0)
  const block = db.prepare(
    `INSERT INTO blocklist (id, term, placeholder_type, created_at) VALUES (?, ?, ?, 'x')`
  )
  block.run('b1', 'Brändli', 'PERSON')
  block.run('b2', 'Klinik Sonnenhalde', 'ORGANISATION')
}

function rows(db: Database.Database, table: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Array<Record<string, unknown>>
}

const NEW_SESSION_COLUMNS = [
  'deleting_at',
  'title_entity_snapshot',
  'summary_entity_snapshot',
  'title_plain',
  'summary_plain',
  'document_date',
  'search_rev'
]

describe('Update von Schema-Version 16 (Stand main) auf den Endstand von Epic #192', () => {
  let dirs: string[]

  beforeEach(() => {
    dirs = []
  })

  afterEach(() => {
    closeDatabase()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade16-'))
    dirs.push(dir)
    home.path = dir
    return dir
  }

  it('registriert 017–021 lückenlos und aufsteigend nach den 16 Migrationen von main', () => {
    expect(migrations.map((m) => m.version)).toEqual(
      Array.from({ length: migrations.length }, (_, i) => i + 1)
    )
    expect(migrations.filter((m) => m.version > MAIN_SCHEMA_VERSION).map((m) => m.version)).toEqual(
      [17, 18, 19, 20, 21]
    )
  })

  it('ein frisch angelegtes und ein von Version 16 migriertes Schema sind identisch', () => {
    const freshDir = freshHome()
    const fresh = initDatabase(join(freshDir, 'fresh.db'))
    const freshSchema = schemaOf(fresh)
    const freshVersions = rows(fresh, 'schema_version').map((r) => r.version)
    const freshMaintenance = rows(fresh, 'app_maintenance').map((r) => [r.task, r.done_at !== null])
    closeDatabase()

    const upgradeDir = freshHome()
    const path = join(upgradeDir, 'upgraded.db')
    createVersion16Database(path, seedRealisticStock)
    const upgraded = initDatabase(path)

    expect(schemaOf(upgraded)).toEqual(freshSchema)
    expect(rows(upgraded, 'schema_version').map((r) => r.version)).toEqual(freshVersions)
    expect(rows(upgraded, 'app_maintenance').map((r) => [r.task, r.done_at !== null])).toEqual(
      freshMaintenance
    )
  })

  it('behält alle Bestandsdaten, führt die einmalige Wartung aus und startet die Aufbereitung für die Suche', () => {
    const dir = freshHome()
    const path = join(dir, 'therascript.db')
    createVersion16Database(path, seedRealisticStock)
    const before = new Database(path, { readonly: true })
    const sessionsBefore = rows(before, 'sessions')
    const tasksBefore = rows(before, 'task_queue')
    const blocklistBefore = rows(before, 'blocklist')
    before.close()
    expect(sessionsBefore).toHaveLength(10)

    const db = initDatabase(path)

    // Alle Sitzungen mit allen bisherigen Spalten unverändert (#202 PC 3, NFR 7)
    const sessionsAfter = rows(db, 'sessions')
    expect(
      sessionsAfter.map((s) =>
        Object.fromEntries(Object.entries(s).filter(([k]) => !NEW_SESSION_COLUMNS.includes(k)))
      )
    ).toEqual(sessionsBefore)
    for (const s of sessionsAfter) {
      expect(s.deleting_at).toBeNull()
      expect(s.document_date).toBeNull()
      expect(s.search_rev).toBe(0)
    }
    expect(rows(db, 'task_queue')).toEqual(tasksBefore)
    expect(rows(db, 'blocklist')).toEqual(blocklistBefore)
    expect(rows(db, 'dossiers')).toEqual([])
    expect(rows(db, 'session_dossiers')).toEqual([])
    expect(rows(db, 'recent_items')).toEqual([])
    expect(rows(db, 'search_recent_queries')).toEqual([])

    // Einmalige Wartung: beide Schritte erledigt
    const maintenance = Object.fromEntries(
      rows(db, 'app_maintenance').map((r) => [r.task, r.done_at])
    )
    expect(maintenance[SECURE_DELETE_VACUUM]).toEqual(expect.any(String))
    expect(maintenance[PLACEHOLDER_PLAIN_BACKFILL]).toEqual(expect.any(String))

    // Klartext-Backfill (#203 AK 4): Titel und Zusammenfassung des Bestands aufgelöst
    const review = sessionsAfter.find((s) => s.id === 'audio-review')!
    expect(review.title_plain).toBe('Gespräch mit Anna Brändli in Winterthur')
    expect(review.summary_plain).toBe('Anna Brändli berichtet über den Umzug nach Winterthur.')
    expect(sessionsAfter.find((s) => s.id === 'audio-error')!.title_plain).toBeNull()

    // Aufbereitung für die Suche (#210 AK 1): der Bestand ist ohne Aktivierung
    // ausstehend und wird von der Textphase indexiert
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Ein Gespräch über Prüfungsangst.' }] }
      ]
    }
    const service = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: () => doc
    })
    let indexed = 0
    for (let round = 0; round < 100; round++) {
      const r = service.runTextPhase(1000)
      indexed += r.indexed
      if (!r.more) break
    }
    // Nur fertig verarbeitete Sitzungen (review) gehören in den Index
    expect(indexed).toBe(2)
    const hits = new SearchService(db)
      .query({ requestId: 1, query: 'prüfungsangst', scope: { kind: 'all' } })
      .results.map((r) => r.sessionId)
      .sort()
    expect(hits).toEqual(['audio-review', 'pdf-review'])
    service.stop()
  })
})
