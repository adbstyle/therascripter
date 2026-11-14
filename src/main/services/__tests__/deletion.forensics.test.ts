import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Epic #192, Erfolgskriterium 9 (Abschluss-Check): Nach dem Löschen sind eine
// Sitzung, ein PDF-Dokument oder ein Patientendossier samt ALLEN daraus
// abgeleiteten Daten weder auffindbar noch wiederherstellbar. Die Einzeltests
// der Stories prüfen je einen Ausschnitt; dieser Test legt eine Sitzung mit
// jeder Art abgeleiteter Daten zugleich an und sucht danach in den Rohbytes
// von .db und -wal sowie im ganzen Datenordner:
//  - Dateien: audio, transcripts (+ aligned), diarization, anonymized, pdf,
//    extracted, recovery
//  - sessions-Zeile: Titel, Zusammenfassung, EntityMap, Snapshots, Klartext-
//    Spalten, Dokumentdatum
//  - task_queue (Fehlertext), session_dossiers, recent_items
//  - Suchindex: search_chunks inkl. Vektoren, FTS-Schattentabellen
//    (Trigramme), search_index_state
//  - beim Löschen eines Dossiers: seine Felder und die letzten Suchanfragen,
//    die es nennen
// Wie in der App läuft die Schleife des Suchindex (gestaffeltes Löschen).

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { initDatabase, getDatabase, closeDatabase } from '../../db/connection'
import { SessionService } from '../SessionService'
import { DossierService } from '../DossierService'
import { SessionDossierService } from '../SessionDossierService'
import { RecentService } from '../RecentService'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import { SearchRecentRepository } from '../../db/repositories/SearchRecentRepository'
import {
  SearchIndexService,
  initSearchIndexService,
  resetSearchIndexServiceForTests
} from '../../search/SearchIndexService'
import { SearchService } from '../../search/SearchService'
import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import { makeDoc } from '../../search/__tests__/helpers'

const DATA_SUBDIRS = [
  'audio',
  'transcripts',
  'diarization',
  'anonymized',
  'pdf',
  'extracted',
  'recovery'
]

/** Seltene Buchstabenfolgen je Datenart und Sitzung — ihre Trigramme kommen sonst nirgends vor. */
interface SessionMarkers {
  text: string
  chip: string
  title: string
  summary: string
  taskError: string
  file: string
  vector: string
}

function markersFor(tag: string): SessionMarkers {
  return {
    text: `Qxzjvy${tag}text`,
    chip: `Wqxzpf${tag}chip`,
    title: `Zyqxvb${tag}titel`,
    summary: `Kqxzwm${tag}zusf`,
    taskError: `Jqxzvt${tag}task`,
    file: `Fqxzdv${tag}datei`,
    vector: `Vqxzvk${tag}vekt`
  }
}

function trigramsOf(text: string): string[] {
  const norm = normalizeSearchText(text)
  const out: string[] = []
  for (let i = 0; i + 3 <= norm.length; i++) out.push(norm.slice(i, i + 3))
  return out
}

/**
 * Marker plus normalisierte Form und Trigramme der Texte, die in den
 * FTS-Index gehen. Trigramme, die auch in den Markern einer bleibenden Sitzung
 * vorkommen (`survivors`), dürfen in der Datei bleiben und zählen nicht.
 */
function needlesFor(m: SessionMarkers, survivors: SessionMarkers[] = []): string[] {
  const indexed = [m.text, m.chip, m.title, m.summary]
  const kept = new Set(survivors.flatMap((s) => Object.values(s).flatMap(trigramsOf)))
  const trigrams = indexed
    .flatMap(trigramsOf)
    // Nur Trigramme mit seltenen Buchstabenpaaren — gewöhnlicher Text enthält sie nicht
    .filter((t) => /q.*x|x.*z|q.*z/.test(t) && !kept.has(t))
  return [...Object.values(m), ...indexed.map(normalizeSearchText), ...trigrams]
}

function bytesContaining(dbPath: string, needles: string[]): string[] {
  const found: string[] = []
  for (const file of [dbPath, `${dbPath}-wal`]) {
    if (!existsSync(file)) continue
    const bytes = readFileSync(file)
    for (const needle of needles) {
      if (bytes.includes(Buffer.from(needle, 'utf-8'))) found.push(`${file}: ${needle}`)
    }
  }
  return found
}

/** Dateien im Datenordner, die eine Sitzung nennen oder einen Marker enthalten. */
function dataDirTraces(dataDir: string, sessionId: string, needles: string[]): string[] {
  const found: string[] = []
  for (const sub of DATA_SUBDIRS) {
    const dir = join(dataDir, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (name.includes(sessionId)) found.push(path)
      const bytes = readFileSync(path)
      for (const needle of needles) {
        if (bytes.includes(Buffer.from(needle, 'utf-8'))) found.push(`${path}: ${needle}`)
      }
    }
  }
  return found
}

function countWhere(table: string, column: string, value: string): number {
  return (
    getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
      n: number
    }
  ).n
}

describe('Epic #192 Erfolgskriterium 9 — Löschen über alle abgeleiteten Daten zusammen', () => {
  let dbPath: string
  let dataDir: string
  let indexer: SearchIndexService

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'forensics-epic192-'))
    dataDir = join(home.path, '.therascript')
    dbPath = join(home.path, 'therascript.db')
    initDatabase(dbPath)
    indexer = initSearchIndexService(getDatabase(), {
      // Ruhiges Fenster überspringen: «jetzt» liegt eine Minute in der Zukunft
      now: () => Date.now() + 60_000,
      finishDeletion: (id) => {
        new SessionService(getDatabase()).finishDeletion(id)
      }
    })
    indexer.start()
  })

  afterEach(() => {
    resetSearchIndexServiceForTests()
    closeDatabase()
    rmSync(home.path, { recursive: true, force: true })
  })

  /** Eine fertig verarbeitete Sitzung mit jeder Art abgeleiteter Daten. */
  function fullSession(type: 'audio' | 'pdf', m: SessionMarkers): string {
    const db = getDatabase()
    const sessions = new SessionService(db)
    const session = sessions.createSession(`Neu ${m.title}`, type)
    const id = session.id
    const path = (sub: string, name: string): string => join(dataDir, sub, name)
    const files = {
      audioPath: path('audio', `${id}.wav`),
      transcriptPath: path('transcripts', `${id}.json`),
      alignedTranscriptPath: path('transcripts', `${id}-aligned.json`),
      diarizationPath: path('diarization', `${id}.json`),
      anonymizedPath: path('anonymized', `${id}.json`),
      pdfPath: path('pdf', `${id}.pdf`),
      extractedPath: path('extracted', `${id}.json`)
    }
    for (const p of [...Object.values(files), path('recovery', `${id}.pcm`)]) {
      if (p !== files.anonymizedPath) writeFileSync(p, `${m.file} ${m.text} ${m.chip}`)
    }
    writeFileSync(
      files.anonymizedPath,
      JSON.stringify(
        makeDoc([
          { speaker: 'A', text: `Wir sprachen über ${m.text} und Schlaf.` },
          { speaker: 'B', text: `Mit {{${m.chip}|PERSON|1}} war ich unterwegs.` }
        ])
      )
    )
    // PDF-Sitzungen beginnen schon in «queued»
    if (session.status === 'recording') sessions.updateSession(id, { status: 'queued' })
    sessions.updateSession(id, { status: 'processing' })
    sessions.updateSession(id, {
      ...files,
      status: 'review',
      entityMap: {
        e1: { original: m.chip, placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
      }
    })
    // Titel und Zusammenfassung mit Platzhalter: Snapshots und Klartext-Spalten (#203)
    sessions.saveGeneratedSummary(
      id,
      `Gespräch mit [PERSON 1] ${m.title}`,
      `[PERSON 1] berichtet ${m.summary}.`,
      'gemma'
    )
    const row = db
      .prepare(
        'SELECT title_plain, summary_plain, title_entity_snapshot, summary_entity_snapshot FROM sessions WHERE id = ?'
      )
      .get(id) as Record<string, string | null>
    expect(row.title_plain).toContain(m.chip)
    expect(row.summary_plain).toContain(m.chip)
    expect(row.title_entity_snapshot).toContain(m.chip)
    if (type === 'pdf') expect(sessions.setDocumentDate(id, '1913-07-29')).toEqual({ ok: true })
    // Task-Zeile mit Fehlertext
    const tasks = new TaskRepository(db)
    const task = tasks.create({ sessionId: id, type: 'summarization' })
    tasks.update(task.id, { status: 'failed', error: `Fehler ${m.taskError}` })
    // «Zuletzt geöffnet»
    new RecentService(db).touch({ kind: 'session', id })
    // Suchindex: Text, FTS, dann Vektoren (Markerbytes im BLOB) und Fehlerzustand
    while (indexer.runTextPhase(1000).more) {
      /* Textphase vollständig */
    }
    expect(countWhere('search_chunks', 'session_id', id)).toBeGreaterThan(0)
    db.prepare('UPDATE search_chunks SET vec = ?, vec_scale = 1 WHERE session_id = ?').run(
      Buffer.from(`${m.vector}${'\0'.repeat(32)}`, 'utf-8'),
      id
    )
    db.prepare(
      `UPDATE search_index_state SET vec_gen = text_gen, model_id = 'm', last_error = ? WHERE session_id = ?`
    ).run(`Fehler ${m.vector}`, id)
    return id
  }

  function hits(query: string): string[] {
    return new SearchService(getDatabase())
      .query({ requestId: 1, query, scope: { kind: 'all' } })
      .results.map((r) => r.sessionId)
  }

  /** Inhalt in der Datei UND eine jüngere Fassung im WAL — der schwere Fall. */
  function splitAcrossDbAndWal(id: string): void {
    getDatabase().pragma('wal_checkpoint(TRUNCATE)')
    getDatabase().prepare('UPDATE sessions SET updated_at = updated_at WHERE id = ?').run(id)
  }

  function expectGone(id: string, m: SessionMarkers, survivors: SessionMarkers[]): void {
    const needles = [...needlesFor(m, survivors), id, '1913-07-29']
    for (const table of [
      'sessions',
      'task_queue',
      'session_dossiers',
      'recent_items',
      'search_chunks',
      'search_index_state'
    ]) {
      const column = table === 'sessions' ? 'id' : 'session_id'
      expect(countWhere(table, column, id), table).toBe(0)
    }
    for (const marker of [m.text, m.chip, m.title, m.summary]) expect(hits(marker)).toEqual([])
    expect(bytesContaining(dbPath, needles)).toEqual([])
    expect(dataDirTraces(dataDir, id, needles)).toEqual([])
  }

  /**
   * Gegenprobe vor dem Löschen: jede Nadel liegt irgendwo in .db, -wal oder im
   * Datenordner, und jede Tabelle hat Zeilen der Sitzung — sonst bewiese
   * expectGone nichts.
   */
  function expectTracesBefore(id: string, m: SessionMarkers, survivors: SessionMarkers[]): void {
    for (const table of [
      'task_queue',
      'session_dossiers',
      'recent_items',
      'search_chunks',
      'search_index_state'
    ]) {
      expect(countWhere(table, 'session_id', id), table).toBeGreaterThan(0)
    }
    const needles = [...needlesFor(m, survivors), id]
    const inDb = new Set(bytesContaining(dbPath, needles).map((f) => f.slice(f.indexOf(': ') + 2)))
    const inFiles = new Set(
      dataDirTraces(dataDir, id, needles).map((f) => f.slice(f.indexOf(': ') + 2))
    )
    expect(needles.filter((n) => !inDb.has(n) && !inFiles.has(n))).toEqual([])
    // In jedem Datenordner liegt mindestens eine Datei der Sitzung
    expect(
      DATA_SUBDIRS.filter((sub) => !readdirSync(join(dataDir, sub)).some((f) => f.includes(id)))
    ).toEqual([])
  }

  function expectPresent(id: string, m: SessionMarkers): void {
    expect(countWhere('sessions', 'id', id)).toBe(1)
    expect(hits(m.text)).toEqual([id])
    expect(existsSync(join(dataDir, 'anonymized', `${id}.json`))).toBe(true)
  }

  it('eine Sitzung bzw. ein PDF-Dokument: keine Spur in .db, -wal und Datenordner', () => {
    const db = getDatabase()
    const dossiers = new DossierService(db)
    const created = dossiers.create({ firstName: 'Bleibt', lastName: 'Erhalten' })
    if (!created.ok) throw new Error('create')
    const pdf = markersFor('a')
    const audio = markersFor('b')
    const pdfId = fullSession('pdf', pdf)
    const audioId = fullSession('audio', audio)
    const links = new SessionDossierService(db)
    expect(links.assign(pdfId, created.dossier.id).ok).toBe(true)
    expect(links.assign(audioId, created.dossier.id).ok).toBe(true)
    new RecentService(db).touch({ kind: 'dossier', id: created.dossier.id })
    splitAcrossDbAndWal(pdfId)
    expectTracesBefore(pdfId, pdf, [audio])
    expect(bytesContaining(dbPath, ['1913-07-29']).length).toBeGreaterThan(0)

    expect(new SessionService(db).deleteSession(pdfId)).toBe(true)
    indexer.drain()

    expectGone(pdfId, pdf, [audio])
    // Was nicht zur gelöschten Sitzung gehört, bleibt
    expectPresent(audioId, audio)
    expect(dossiers.get(created.dossier.id)?.lastName).toBe('Erhalten')
    expect(countWhere('recent_items', 'dossier_id', created.dossier.id)).toBe(1)
    // Auch nach dem Schliessen (Checkpoint beim Schliessen) bleibt es so
    resetSearchIndexServiceForTests()
    closeDatabase()
    expect(bytesContaining(dbPath, [...needlesFor(pdf, [audio]), pdfId, '1913-07-29'])).toEqual([])
  })

  it('ein Patientendossier samt exklusiver Sitzungen: keine Spur, geteilte Sitzung und andere Anfragen bleiben', () => {
    const db = getDatabase()
    const dossiers = new DossierService(db)
    const dm = {
      firstName: 'Kxqvan',
      lastName: 'Zxqbert',
      externalId: 'PD-QX81',
      diagnoses: 'Dqxzdiag',
      medication: 'Mqxzmedi',
      note: 'Nqxznotiz'
    }
    const target = dossiers.create({
      firstName: dm.firstName,
      lastName: dm.lastName,
      externalId: dm.externalId
    })
    const other = dossiers.create({ firstName: 'Andere', lastName: 'Person' })
    if (!target.ok || !other.ok) throw new Error('create')
    const dossierId = target.dossier.id
    dossiers.update(dossierId, {
      diagnoses: `Diagnose ${dm.diagnoses}`,
      medication: `Medikation ${dm.medication}`,
      note: `Notiz ${dm.note}`
    })
    const audio = markersFor('c')
    const pdf = markersFor('d')
    const shared = markersFor('e')
    const audioId = fullSession('audio', audio)
    const pdfId = fullSession('pdf', pdf)
    const sharedId = fullSession('audio', shared)
    const links = new SessionDossierService(db)
    for (const id of [audioId, pdfId, sharedId]) expect(links.assign(id, dossierId).ok).toBe(true)
    expect(links.assign(sharedId, other.dossier.id).ok).toBe(true)
    new RecentService(db).touch({ kind: 'dossier', id: dossierId })
    const recent = new SearchRecentRepository(db)
    recent.remember('Kxqvan Schlaf')
    recent.remember('pd-qx81')
    recent.remember('Zxqbert')
    recent.remember('Velofahrt')
    splitAcrossDbAndWal(audioId)
    const dossierNeedles = [
      ...Object.values(dm),
      'kxqvan',
      'zxqbert',
      'pd-qx81',
      'Kxqvan Schlaf',
      dossierId
    ]
    expectTracesBefore(audioId, audio, [shared])
    expectTracesBefore(pdfId, pdf, [shared])
    const inDb = bytesContaining(dbPath, dossierNeedles).map((f) => f.slice(f.indexOf(': ') + 2))
    expect(dossierNeedles.filter((n) => !inDb.includes(n))).toEqual([])

    const { fingerprint } = dossiers.deletePreview(dossierId)!
    const result = dossiers.deleteDossier(dossierId, fingerprint)
    expect(result).toMatchObject({ ok: true, incomplete: false })
    expect(result.ok && [...result.deletedSessionIds].sort()).toEqual([audioId, pdfId].sort())
    indexer.drain()

    expectGone(audioId, audio, [shared])
    expectGone(pdfId, pdf, [shared])
    expect(countWhere('dossiers', 'id', dossierId)).toBe(0)
    expect(countWhere('session_dossiers', 'dossier_id', dossierId)).toBe(0)
    expect(countWhere('recent_items', 'dossier_id', dossierId)).toBe(0)
    expect(bytesContaining(dbPath, dossierNeedles)).toEqual([])
    // Die geteilte Sitzung bleibt vollständig im anderen Dossier (Epic EK 8)
    expectPresent(sharedId, shared)
    expect(links.listForSession(sharedId).map((d) => d.id)).toEqual([other.dossier.id])
    // Anfragen ohne Bezug zum Dossier bleiben (#209 PC 4 nur für dieses Dossier)
    expect(recent.list().map((q) => q.query)).toEqual(['Velofahrt'])

    resetSearchIndexServiceForTests()
    closeDatabase()
    expect(
      bytesContaining(dbPath, [
        ...dossierNeedles,
        ...needlesFor(audio, [shared]),
        ...needlesFor(pdf, [shared]),
        audioId,
        pdfId,
        '1913-07-29'
      ])
    ).toEqual([])
  })
})
