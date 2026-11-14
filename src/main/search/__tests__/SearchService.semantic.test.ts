import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { SearchService, type SemanticSearchDeps } from '../SearchService'
import { SearchIndexService } from '../SearchIndexService'
import { VectorStore } from '../VectorStore'
import { SearchWorkerUnavailableError } from '../SearchWorker'
import { addIndexedSession, createSearchTestDb, indexAll } from './helpers'
import { TEST_MODEL, fakeEmbed } from './semanticHelpers'
import type {
  SearchProcessState,
  SearchQueryResult,
  SearchScope
} from '../../../shared/types/Search'

// Suche nach Bedeutung (PR S4): Einbetten, Kosinus, Schwelle, Ranking mit den
// exakten Treffern, Dossier-Filter NACH dem Ranking (#211 AK 3).

describe('SearchService — Suche nach Bedeutung', () => {
  let db: Database.Database
  let store: VectorStore
  let state: SearchProcessState
  let embedQuery: (text: string) => Promise<Float32Array>
  let service: SearchService

  beforeEach(async () => {
    db = createSearchTestDb()
    const docs = new Map<string, unknown>()
    const sessions: Array<[string, string, string]> = [
      [
        'schlaf-1',
        '2026-03-01',
        'Ich schlafe schlecht und wache nachts oft auf, die Nacht ist lang.'
      ],
      ['schlaf-2', '2026-04-01', 'Die Nacht war unruhig, Schlaf kam erst gegen Morgen.'],
      ['arbeit', '2026-05-01', 'Im Büro gibt es Konflikt mit dem Chef wegen der Arbeit.'],
      ['ferien', '2026-02-01', 'Die Ferien am Meer waren erholsam, Sonne und Strand.'],
      ['wort', '2026-01-01', 'Das Wort Nachtzug steht hier, sonst nichts Passendes.']
    ]
    for (const [id, day, text] of sessions) {
      addIndexedSession(
        db,
        docs,
        { id, title: `Sitzung ${id}`, createdAt: `${day}T09:00:00.000Z` },
        [{ speaker: 'A', text }]
      )
    }
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => false,
        embedDocuments: async (texts) => texts.map((t) => fakeEmbed(t))
      }
    })
    indexAll(index)
    await index.runVectorPhaseToEnd()
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm, created_at, updated_at)
       VALUES ('d1', 'Anna', 'Muster', 'anna', 'muster', 'x', 'x')`
    ).run()
    for (const id of ['schlaf-2', 'wort', 'ferien']) {
      db.prepare(
        `INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, 'd1', 'x')`
      ).run(id)
    }
    store = new VectorStore(db)
    state = { phase: 'ready', reason: null }
    embedQuery = async (text) => fakeEmbed(text)
    const deps: SemanticSearchDeps = {
      embedQuery: (t) => embedQuery(t),
      getState: () => state,
      store,
      resolveModel: () => TEST_MODEL,
      threshold: 0.2
    }
    service = new SearchService(db, { semantic: deps })
  })

  afterEach(() => db.close())

  const input = (query: string, scope: SearchScope = { kind: 'all' }) => ({
    requestId: 4,
    query,
    scope
  })

  function ids(result: SearchQueryResult): string[] {
    return result.results.map((r) => r.sessionId)
  }

  it('search:query reports pending while the search by meaning is possible', () => {
    expect(service.query(input('Nacht')).semantic).toBe('pending')
    state = { phase: 'stopped', reason: 'processing' }
    expect(service.query(input('Nacht')).semantic).toBe('unavailable-processing')
    state = { phase: 'stopped', reason: 'tool-blocked' }
    expect(service.query(input('Nacht')).semantic).toBe('tool-blocked')
  })

  it('merges exact hits first, then hits by meaning by cosine, only above the threshold', async () => {
    const result = await service.semantic(input('Nacht Schlaf'))
    expect(result.semantic).toBe('complete')
    const order = ids(result)
    // Exakt (beide Wörter als Teilwort im Abschnitt): schlaf-1 («schlafe», «Nacht»)
    // und schlaf-2; danach nach Bedeutung; ferien liegt unter der Schwelle
    expect(order.slice(0, 2).sort()).toEqual(['schlaf-1', 'schlaf-2'])
    expect(order).not.toContain('ferien')
    const exact = result.results.filter((r) => r.hits.some((h) => h.kind === 'exact'))
    expect(exact.map((r) => r.sessionId).sort()).toEqual(['schlaf-1', 'schlaf-2'])
    const semantic = result.results.slice(2)
    expect(semantic.every((r) => r.hits.every((h) => h.kind === 'semantic'))).toBe(true)
  })

  it('finds by meaning without an exact hit, without marks in the snippet', async () => {
    // Kein Abschnitt enthält beide Wörter → keine exakten Treffer; beide Sitzungen
    // teilen aber je ein Wort mit der Anfrage (Ersatzmodell: Wort-Hashing)
    const result = await service.semantic(input('Konflikt Strand'))
    expect(service.query(input('Konflikt Strand')).results).toEqual([])
    expect(ids(result).sort()).toEqual(['arbeit', 'ferien'])
    for (const doc of result.results) {
      const hit = doc.hits[0]
      expect(hit.kind).toBe('semantic')
      expect(hit.snippet.marks).toEqual([])
      expect(hit.focus).toMatchObject({ kind: 'hit', paraFrom: 0, paraTo: 0 })
    }
  })

  it('the dossier search is exactly the filtered overall search in the same order (#211 AK 3)', async () => {
    for (const query of ['nacht schlafen', 'Ferien Meer Nacht', 'Wort Schlaf Büro', 'Sonne']) {
      const all = await service.semantic(input(query))
      const inDossier = await service.semantic(input(query, { kind: 'dossier', dossierId: 'd1' }))
      const allowed = new Set(['schlaf-2', 'wort', 'ferien'])
      expect(ids(inDossier)).toEqual(ids(all).filter((id) => allowed.has(id)))
      expect(inDossier.results.map((r) => r.hits)).toEqual(
        all.results.filter((r) => allowed.has(r.sessionId)).map((r) => r.hits)
      )
      expect(inDossier.dossiers).toEqual([])
    }
  })

  it('returns the exact hits with the reason when the search by meaning is unavailable', async () => {
    state = { phase: 'stopped', reason: 'processing' }
    const result = await service.semantic(input('nacht'))
    expect(result.semantic).toBe('unavailable-processing')
    expect(ids(result).sort()).toEqual(['schlaf-1', 'schlaf-2', 'wort'])
    state = { phase: 'ready', reason: null }
    embedQuery = async () => {
      throw new SearchWorkerUnavailableError('error')
    }
    expect((await service.semantic(input('nacht'))).semantic).toBe('error')
  })

  it('a superseded request ends with the exact hits only', async () => {
    const result = await service.semantic(input('nacht'), { isSuperseded: () => true })
    expect(result.semantic).toBe('superseded')
    let calls = 0
    embedQuery = async (t) => {
      calls++
      return fakeEmbed(t)
    }
    let superseded = false
    const pending = service.semantic(input('nacht'), { isSuperseded: () => superseded })
    superseded = true
    expect((await pending).semantic).toBe('superseded')
    expect(calls).toBeLessThanOrEqual(1)
  })

  it('never returns a session marked for deletion, even if its vectors are still loaded', async () => {
    await store.load('test-model')
    db.prepare("UPDATE sessions SET deleting_at = 'x' WHERE id = 'arbeit'").run()
    const result = await service.semantic(input('Konflikt Chef Arbeit'))
    expect(ids(result)).not.toContain('arbeit')
  })

  it('exposes the internal chunk ranking before the threshold (for PR S6)', async () => {
    const chunks = await service.rankChunks('Nacht Schlaf', { threshold: null })
    expect(chunks.length).toBeGreaterThanOrEqual(10)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1].cosine).toBeGreaterThanOrEqual(chunks[i].cosine)
    }
  })
})
