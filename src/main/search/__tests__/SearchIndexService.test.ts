import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SearchIndexRepository } from '../../db/repositories/SearchIndexRepository'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { SessionService } from '../../services/SessionService'
import { SearchIndexService } from '../SearchIndexService'
import { ReviewService } from '../../services/ReviewService'
import { SearchService } from '../SearchService'
import { SEARCH_QUIET_WINDOW_MS, SEARCH_TICK_MS } from '../../../shared/search-config'
import {
  addIndexedSession,
  createIndexService,
  createSearchTestDb,
  indexAll,
  insertSession,
  makeDoc
} from './helpers'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/home') },
  BrowserWindow: { getAllWindows: () => [] }
}))

const NOW = Date.parse('2026-06-01T00:00:00.000Z')

function rev(db: Database.Database, id: string): number {
  return (
    db.prepare('SELECT search_rev FROM sessions WHERE id = ?').get(id) as { search_rev: number }
  ).search_rev
}

function state(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM search_index_state WHERE session_id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

function hitIds(db: Database.Database, query: string): string[] {
  return new SearchService(db)
    .query({ requestId: 1, query, scope: { kind: 'all' } })
    .results.map((r) => r.sessionId)
}

describe('SearchIndexService — text phase', () => {
  let db: Database.Database
  let docs: Map<string, unknown>

  beforeEach(() => {
    db = createSearchTestDb()
    docs = new Map()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('indexes the stock before the update without any activation (#210 AK 1, #209 AK 1)', () => {
    addIndexedSession(db, docs, { id: 'old', searchRev: 0 }, [
      { speaker: 'A', text: 'Ein Gespräch über Prüfungsangst.' }
    ])
    const service = createIndexService(db, docs)
    expect(indexAll(service)).toBe(1)
    expect(state(db, 'old')).toMatchObject({ text_gen: 1, text_rev: 0, vec_gen: null })
    expect(hitIds(db, 'prüfungsangst')).toEqual(['old'])
  })

  it('handles changed and newly processed sessions before the stock', () => {
    insertSession(db, { id: 'stock', searchRev: 0, updatedAt: '2026-05-01T00:00:00.000Z' })
    insertSession(db, { id: 'changed', searchRev: 3, updatedAt: '2026-01-01T00:00:00.000Z' })
    const pending = new SearchIndexRepository(db).findPendingText(new Date(NOW).toISOString(), 10)
    expect(pending.map((p) => p.id)).toEqual(['changed', 'stock'])
  })

  it('skips sessions that are not finished, marked for deletion or changed within the quiet window', () => {
    insertSession(db, { id: 'processing', status: 'processing' })
    insertSession(db, { id: 'deleting', deletingAt: '2026-05-01T00:00:00.000Z' })
    insertSession(db, {
      id: 'fresh',
      updatedAt: new Date(NOW - SEARCH_QUIET_WINDOW_MS + 1000).toISOString()
    })
    insertSession(db, {
      id: 'quiet',
      updatedAt: new Date(NOW - SEARCH_QUIET_WINDOW_MS - 1000).toISOString()
    })
    const service = createIndexService(db, docs)
    indexAll(service)
    expect(state(db, 'processing')).toBeUndefined()
    expect(state(db, 'deleting')).toBeUndefined()
    expect(state(db, 'fresh')).toBeUndefined()
    expect(state(db, 'quiet')).toBeDefined()
  })

  it('replaces the text generation in one step; the loop removes the old one later (#212 AK 1)', () => {
    addIndexedSession(db, docs, { id: 's1' }, [
      { speaker: 'A', text: 'Alter Stand mit Velofahrt.' }
    ])
    const service = createIndexService(db, docs)
    indexAll(service)
    expect(hitIds(db, 'velofahrt')).toEqual(['s1'])

    // Bearbeitung: bis zur Textphase bleibt der bisherige Stand auffindbar
    docs.set('/docs/s1.json', makeDoc([{ speaker: 'A', text: 'Neuer Stand mit Zugfahrt.' }]))
    db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    expect(hitIds(db, 'velofahrt')).toEqual(['s1'])
    expect(hitIds(db, 'zugfahrt')).toEqual([])

    indexAll(service)
    expect(hitIds(db, 'velofahrt')).toEqual([])
    expect(hitIds(db, 'zugfahrt')).toEqual(['s1'])
    expect(state(db, 's1')).toMatchObject({ text_gen: 2, text_rev: 2 })
    const gens = (): unknown[] =>
      db
        .prepare('SELECT DISTINCT gen FROM search_chunks WHERE session_id = ? ORDER BY gen')
        .all('s1')
    // Die alte Generation ist unsichtbar, aber noch da — die Schleife räumt sie weg
    expect(gens()).toEqual([{ gen: 1 }, { gen: 2 }])
    service.drain()
    expect(gens()).toEqual([{ gen: 2 }])
    expect(hitIds(db, 'zugfahrt')).toEqual(['s1'])
  })

  it('keeps the generation an active vector generation points at (two-generation model)', () => {
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Erster Stand.' }])
    const service = createIndexService(db, docs)
    indexAll(service)
    // vec_gen setzt sonst die Vektorphase; hier von Hand
    db.prepare('UPDATE search_index_state SET vec_gen = 1 WHERE session_id = ?').run('s1')
    db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    indexAll(service)
    db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    indexAll(service)
    service.drain()
    const gens = db
      .prepare('SELECT DISTINCT gen FROM search_chunks WHERE session_id = ? ORDER BY gen')
      .all('s1')
    expect(gens).toEqual([{ gen: 1 }, { gen: 3 }])
    expect(state(db, 's1')).toMatchObject({ text_gen: 3, vec_gen: 1 })
    // Die exakte Suche liest nur die aktive Textgeneration
    expect(new SearchIndexRepository(db).findActiveChunks('s1').every((c) => c.text)).toBe(true)
  })

  it('indexes title and summary even if the document cannot be read and records the error', () => {
    insertSession(db, { id: 's1', title: 'Gespräch Lina', summary: 'Es ging um Schlaf.' })
    const service = createIndexService(db, docs)
    indexAll(service)
    expect(state(db, 's1')?.last_error).toMatch(/Dokument nicht lesbar/)
    expect(hitIds(db, 'schlaf')).toEqual(['s1'])
  })

  it('never runs while recording and catches up afterwards (#209 AK 19, #212 AK 3)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Text.' }])
    const service = createIndexService(db, docs, () => Date.now())
    service.setRecordingPause(true)
    service.start()
    vi.advanceTimersByTime(SEARCH_TICK_MS * 3)
    expect(service.runTextPhase()).toEqual({ indexed: 0, more: false })
    expect(state(db, 's1')).toBeUndefined()

    service.setRecordingPause(false)
    vi.advanceTimersByTime(1)
    expect(state(db, 's1')).toBeDefined()
    service.stop()
  })

  it('picks up a change on its tick after the quiet window, within a minute (#212 AK 2)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    addIndexedSession(db, docs, { id: 's1', updatedAt: new Date(NOW).toISOString() }, [
      { speaker: 'A', text: 'Text.' }
    ])
    const service = createIndexService(db, docs, () => Date.now())
    service.start()
    vi.advanceTimersByTime(SEARCH_QUIET_WINDOW_MS - 1)
    expect(state(db, 's1')).toBeUndefined()
    vi.advanceTimersByTime(SEARCH_TICK_MS + 1)
    expect(state(db, 's1')).toBeDefined()
    service.stop()
  })

  it('catches up after a restart: a new service finds what was pending (#212 AK 4)', () => {
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Text.' }])
    createIndexService(db, docs).stop()
    const afterRestart = createIndexService(db, docs)
    expect(indexAll(afterRestart)).toBe(1)
  })

  it('does nothing after stop() (quit, update swap)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Text.' }])
    const service = createIndexService(db, docs, () => Date.now())
    service.start()
    await service.stopForUpdate()
    vi.advanceTimersByTime(SEARCH_TICK_MS * 5)
    expect(state(db, 's1')).toBeUndefined()
  })

  it('does not resurrect a session deleted while its change was pending (#212 PC 1)', () => {
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Geheimes Wort.' }])
    const service = createIndexService(db, docs)
    indexAll(service)
    db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    db.prepare(`UPDATE sessions SET deleting_at = '2026-05-31T00:00:00.000Z' WHERE id = ?`).run(
      's1'
    )
    expect(hitIds(db, 'geheimes')).toEqual([])
    indexAll(service)
    expect(hitIds(db, 'geheimes')).toEqual([])
    expect(new SearchIndexRepository(db).writeTextGeneration('s1', 2, [], null)).toBeNull()
  })
})

describe('search_rev — every content write path makes a session pending (#212)', () => {
  let db: Database.Database
  let sessions: SessionService
  let dir: string

  beforeEach(() => {
    db = createSearchTestDb()
    sessions = new SessionService(db)
    dir = mkdtempSync(join(tmpdir(), 'search-rev-'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function reviewSession(): string {
    const s = sessions.createSession('Aufnahme', 'audio')
    sessions.updateSession(s.id, { status: 'queued' })
    sessions.updateSession(s.id, { status: 'processing' })
    return s.id
  }

  it('rises on status → review, title, summary, regenerated summary and review:save', () => {
    const id = reviewSession()
    const start = rev(db, id)
    sessions.updateSession(id, { status: 'review' })
    expect(rev(db, id)).toBe(start + 1)
    sessions.updateTitle(id, 'Neuer Titel')
    expect(rev(db, id)).toBe(start + 2)
    sessions.updateSummaryText(id, 'Neue Zusammenfassung')
    expect(rev(db, id)).toBe(start + 3)
    sessions.saveGeneratedSummary(id, 'Titel', 'Text', 'gemma')
    expect(rev(db, id)).toBe(start + 4)

    const anonymizedPath = join(dir, `${id}.json`)
    sessions.updateSession(id, { anonymizedPath })
    expect(rev(db, id)).toBe(start + 4)
    new ReviewService(db).save(id, makeDoc([{ text: 'x' }]) as never, {})
    expect(rev(db, id)).toBe(start + 5)
  })

  it('does not rise on path, counter or progress updates', () => {
    const id = reviewSession()
    const before = rev(db, id)
    sessions.updateSession(id, {
      transcriptPath: '/t.json',
      diarizationPath: '/d.json',
      alignedTranscriptPath: '/a.json',
      wordCount: 5,
      anonymizationCount: 1,
      retryCount: 0,
      plannedSteps: ['transcription'],
      processedWithModels: null
    })
    sessions.updateSession(id, { status: 'processing' })
    expect(rev(db, id)).toBe(before)
  })

  it('hides a marked session at once and purges its index in slices (#209 PC 1)', () => {
    insertSession(db, { id: 's1', title: 'Sitzung Wolkenkratzer' })
    const finished: string[] = []
    const service = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: () => {
        throw new Error('ENOENT')
      },
      finishDeletion: (id) => finished.push(id)
    })
    indexAll(service)
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_chunks').get()).toEqual({ n: 1 })
    db.prepare(`UPDATE sessions SET deleting_at = 'x' WHERE id = 's1'`).run()
    // Markiert: sofort unsichtbar, auch bevor Phase 2 läuft
    expect(hitIds(db, 'wolkenkratzer')).toEqual([])
    new SessionRepository(db).scrubMarkedContent('s1')
    expect(db.prepare(`SELECT title FROM sessions WHERE id = 's1'`).get()).toEqual({ title: '' })
    service.schedulePurge('s1', true)
    service.drain()
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_chunks').get()).toEqual({ n: 0 })
    expect(finished).toEqual(['s1'])
  })

  it('re-indexes after a restart when the document changed without a DB update (crash in review:save)', () => {
    const docs = new Map<string, unknown>()
    addIndexedSession(db, docs, { id: 's1' }, [{ speaker: 'A', text: 'Alter Text.' }])
    const stats = new Map([['/docs/s1.json', '100:1']])
    const make = (): SearchIndexService =>
      new SearchIndexService(db, {
        now: () => Date.parse('2026-06-01T00:00:00.000Z'),
        readDocument: (path) => docs.get(path),
        statDocument: (path) => stats.get(path) ?? null
      })
    make().drain()
    expect(state(db, 's1')).toMatchObject({ text_rev: 1, doc_stat: '100:1' })
    // Datei neu geschrieben, Absturz vor dem DB-Update: search_rev unverändert
    docs.set('/docs/s1.json', makeDoc([{ speaker: 'A', text: 'Neuer Text mit Zugfahrt.' }]))
    stats.set('/docs/s1.json', '120:2')
    make().drain()
    expect(state(db, 's1')).toMatchObject({ text_rev: 2, doc_stat: '120:2' })
    expect(hitIds(db, 'zugfahrt')).toEqual(['s1'])
  })

  it('finds unfinished cleanup after a restart: stale generations and marked sessions', () => {
    insertSession(db, { id: 'stale' })
    insertSession(db, { id: 'marked' })
    const docs = new Map<string, unknown>()
    indexAll(createIndexService(db, docs))
    db.prepare(`UPDATE sessions SET search_rev = search_rev + 1 WHERE id = 'stale'`).run()
    indexAll(createIndexService(db, docs))
    db.prepare(`UPDATE sessions SET deleting_at = 'x' WHERE id = 'marked'`).run()
    // «Neustart»: neue Instanz ohne Gedächtnis
    const afterRestart = createIndexService(db, docs)
    afterRestart.drain()
    const left = db.prepare('SELECT session_id, gen FROM search_chunks ORDER BY session_id').all()
    expect(left).toEqual([{ session_id: 'stale', gen: 2 }])
    expect(state(db, 'marked')).toBeUndefined()
  })
})
