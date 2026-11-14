import { describe, it, expect } from 'vitest'
import { SearchService } from '../SearchService'
import { SearchIndexService } from '../SearchIndexService'
import { VectorStore } from '../VectorStore'
import { addIndexedSession, createSearchTestDb, indexAll } from './helpers'
import { TEST_MODEL, fakeEmbed } from './semanticHelpers'

// #211 AK 3 als Zufallstest (Review PR #226): für jede Anfrage ist die Suche
// in einem Patientendossier genau die gefilterte Suche über alle Inhalte, in
// derselben Reihenfolge und mit denselben Fundstellen.

const WORDS = [
  'Schlaf',
  'Nacht',
  'Arbeit',
  'Chef',
  'Mutter',
  'Vater',
  'Angst',
  'Ferien',
  'Meer',
  'Streit',
  'Freude',
  'Trauer',
  'Schule',
  'Kinder',
  'Geld',
  'Sport',
  'Essen',
  'Musik'
]

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 0x100000000
  }
}

describe('search in a dossier == filtered overall search (random)', () => {
  it('holds for 60 random queries over 40 sessions and 2 dossiers', async () => {
    const r = rng(2026)
    const pick = (): string => WORDS[Math.floor(r() * WORDS.length)]
    const sentence = (): string =>
      `${pick()} und ${pick()} waren Thema, dazu ${pick()} und etwas ${pick()}.`
    const db = createSearchTestDb()
    const docs = new Map<string, unknown>()
    for (let i = 0; i < 40; i++) {
      addIndexedSession(
        db,
        docs,
        {
          id: `s${String(i).padStart(2, '0')}`,
          title: `${pick()} ${pick()}`,
          createdAt: `2026-0${1 + (i % 9)}-1${i % 10}T09:00:00.000Z`
        },
        Array.from({ length: 2 + Math.floor(r() * 8) }, (_, k) => ({
          speaker: k % 2 === 0 ? ('A' as const) : ('B' as const),
          text: Array.from({ length: 3 + Math.floor(r() * 10) }, sentence).join(' ')
        }))
      )
    }
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-12-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => false,
        embedDocuments: async (texts) => texts.map((t) => fakeEmbed(t))
      }
    })
    indexAll(index)
    await index.runVectorPhaseToEnd()
    const dossiers = { d1: new Set<string>(), d2: new Set<string>() }
    for (const d of ['d1', 'd2'] as const) {
      db.prepare(
        `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm, created_at, updated_at)
         VALUES (?, 'A', 'B', 'a', 'b', 'x', 'x')`
      ).run(d)
    }
    for (let i = 0; i < 40; i++) {
      const id = `s${String(i).padStart(2, '0')}`
      for (const d of ['d1', 'd2'] as const) {
        if (r() < 0.4) {
          dossiers[d].add(id)
          db.prepare(
            'INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
          ).run(id, d, 'x')
        }
      }
    }
    const service = new SearchService(db, {
      semantic: {
        embedQuery: async (t) => fakeEmbed(t),
        getState: () => ({ phase: 'ready', reason: null }),
        store: new VectorStore(db),
        resolveModel: () => TEST_MODEL,
        threshold: 0.15
      }
    })
    let compared = 0
    for (let q = 0; q < 60; q++) {
      const query = Array.from({ length: 1 + Math.floor(r() * 3) }, pick).join(' ')
      const all = await service.semantic({ requestId: q, query, scope: { kind: 'all' } })
      expect(all.truncated).toBe(false)
      for (const d of ['d1', 'd2'] as const) {
        const inDossier = await service.semantic({
          requestId: q,
          query,
          scope: { kind: 'dossier', dossierId: d }
        })
        const expected = all.results.filter((x) => dossiers[d].has(x.sessionId))
        expect(inDossier.results.map((x) => x.sessionId)).toEqual(expected.map((x) => x.sessionId))
        expect(inDossier.results.map((x) => x.hits)).toEqual(expected.map((x) => x.hits))
        compared += expected.length
      }
    }
    expect(compared).toBeGreaterThan(100)
    db.close()
  })
})
