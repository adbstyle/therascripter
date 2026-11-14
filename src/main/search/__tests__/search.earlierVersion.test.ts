import { describe, it, expect } from 'vitest'
import { SearchService } from '../SearchService'
import { SearchIndexService } from '../SearchIndexService'
import { VectorStore } from '../VectorStore'
import { addIndexedSession, createSearchTestDb, indexAll, makeDoc } from './helpers'
import { TEST_MODEL, fakeEmbed } from './semanticHelpers'

// Nach einer Bearbeitung bleibt die vorige Vektorgeneration aktiv, bis die neue
// fertig ist (#212 AK 1). Treffer daraus tragen fromEarlierVersion — ihre
// Absatzangaben gehören zur alten Fassung, die Oberfläche nutzt den Anker.

describe('hits from an earlier vector generation', () => {
  it('are marked fromEarlierVersion until the new vectors are complete', async () => {
    const db = createSearchTestDb()
    const docs = new Map<string, unknown>()
    addIndexedSession(db, docs, { id: 's1' }, [
      { speaker: 'A', text: 'Einleitung ohne Bezug.' },
      { speaker: 'B', text: 'Der Hund bellt laut im Garten.' }
    ])
    let embedding = true
    const store = new VectorStore(db)
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => !embedding,
        embedDocuments: async (texts) => texts.map((t) => fakeEmbed(t)),
        onSessionVectorsChanged: (id) => store.refreshSession(id)
      }
    })
    indexAll(index)
    await index.runVectorPhaseToEnd()
    const service = new SearchService(db, {
      semantic: {
        embedQuery: async (t) => fakeEmbed(t),
        getState: () => ({ phase: 'ready', reason: null }),
        store,
        resolveModel: () => TEST_MODEL,
        threshold: 0.2
      }
    })
    const before = await service.semantic({
      requestId: 1,
      query: 'Hund Garten',
      scope: { kind: 'all' }
    })
    expect(before.results[0].hits[0].fromEarlierVersion).toBeUndefined()

    // Bearbeitung: neue Textgeneration, Vektoren dafür noch nicht da
    docs.set('/docs/s1.json', makeDoc([{ speaker: 'B', text: 'Ganz anderer Text über Katzen.' }]))
    db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run('s1')
    indexAll(index)
    embedding = false
    const during = await service.semantic({
      requestId: 2,
      query: 'Hund Garten',
      scope: { kind: 'all' }
    })
    const hit = during.results[0].hits.find((h) => h.kind === 'semantic')!
    expect(hit.fromEarlierVersion).toBe(true)
    expect(hit.focus).toMatchObject({ kind: 'hit', anchor: expect.any(String) })

    embedding = true
    await index.runVectorPhaseToEnd()
    const after = await service.semantic({
      requestId: 3,
      query: 'Hund Garten',
      scope: { kind: 'all' }
    })
    expect(after.results.every((r) => r.hits.every((h) => !h.fromEarlierVersion))).toBe(true)
    db.close()
  })
})
