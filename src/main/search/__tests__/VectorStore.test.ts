import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  VectorStore,
  VectorStoreCancelledError,
  dequantizeVector,
  quantizeVector,
  type VectorRow
} from '../VectorStore'
import { addIndexedSession, createSearchTestDb, indexAll } from './helpers'
import { TEST_MODEL, fakeEmbed } from './semanticHelpers'
import { SearchIndexService } from '../SearchIndexService'
import { SessionService } from '../../services/SessionService'
import { createSearchRuntime, type SearchRuntime } from '../searchRuntime'
import { SEARCH_COSINE_SLICE_MS } from '../../../shared/search-config'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/therascript-test', getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] }
}))

const DIM = 768

/** Deterministischer Zufall (Mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalize(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n)
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** Vektoren in Gruppen um Zentren — wie Embeddings: alle Kosinus im engen Band. */
function clustered(count: number, seed: number): Float32Array[] {
  const r = rng(seed)
  const centers = Array.from({ length: 20 }, () =>
    normalize(Float32Array.from({ length: DIM }, () => r() * 2 - 1))
  )
  return Array.from({ length: count }, (_, i) => {
    const c = centers[i % centers.length]
    return normalize(Float32Array.from({ length: DIM }, (_, k) => c[k] + (r() * 2 - 1) * 0.8))
  })
}

function rows(vectors: Float32Array[], firstId = 1): VectorRow[] {
  return vectors.map((v, i) => ({
    chunkId: firstId + i,
    field: 'body',
    ord: i,
    paraFrom: i,
    paraTo: i,
    vec: quantizeVector(v).q
  }))
}

describe('quantizeVector', () => {
  it('maps float32 to int8 with one scale per vector, symmetric, round trip close', () => {
    const v = normalize(Float32Array.from({ length: DIM }, (_, i) => Math.sin(i)))
    const { q, scale } = quantizeVector(v)
    expect(q).toBeInstanceOf(Int8Array)
    expect(Math.max(...Array.from(q, Math.abs))).toBe(127)
    const back = dequantizeVector(q, scale)
    for (let i = 0; i < DIM; i++)
      expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(scale / 2 + 1e-7)
    expect(quantizeVector(new Float32Array(DIM)).scale).toBe(0)
  })

  it('int8 practically does not change the ranking compared with float32', async () => {
    const docs = clustered(4000, 7)
    const queries = clustered(25, 99)
    const store = new VectorStore(null)
    store.putSession('s', rows(docs))
    let overlap = 0
    let maxDiff = 0
    for (const q of queries) {
      const exact = docs
        .map((d, i) => {
          let dot = 0
          for (let k = 0; k < DIM; k++) dot += d[k] * q[k]
          return { id: i + 1, cos: dot }
        })
        .sort((a, b) => b.cos - a.cos)
      const quant = await store.score(q, { threshold: null })
      const exactCos = new Map(exact.map((e) => [e.id, e.cos]))
      for (const s of quant)
        maxDiff = Math.max(maxDiff, Math.abs(s.cosine - exactCos.get(s.chunkId)!))
      const top = new Set(exact.slice(0, 10).map((e) => e.id))
      overlap += quant.slice(0, 10).filter((s) => top.has(s.chunkId)).length
    }
    // Ø ≥ 9 von 10 gleichen Treffern unter den ersten zehn, Kosinus auf ±0.01
    expect(overlap / queries.length).toBeGreaterThanOrEqual(9)
    expect(maxDiff).toBeLessThan(0.01)
  })
})

describe('VectorStore', () => {
  it('scores all chunks, applies the threshold and sorts descending', async () => {
    const store = new VectorStore(null)
    const a = fakeEmbed('Schlaf Müdigkeit Nacht')
    const b = fakeEmbed('Arbeit Chef Konflikt')
    store.putSession('s1', rows([a], 1))
    store.putSession('s2', rows([b], 2))
    const all = await store.score(fakeEmbed('Schlaf Nacht'), { threshold: null })
    expect(all.map((c) => c.sessionId)).toEqual(['s1', 's2'])
    const some = await store.score(fakeEmbed('Schlaf Nacht'), { threshold: 0.5 })
    expect(some.map((c) => c.sessionId)).toEqual(['s1'])
    expect(some[0]).toMatchObject({ chunkId: 1, field: 'body', paraFrom: 0, paraTo: 0 })
  })

  it('drops sessions removed while a sliced scoring pauses, and can be cancelled', async () => {
    const store = new VectorStore(null)
    for (let s = 0; s < 200; s++) store.putSession(`s${s}`, rows(clustered(40, s), s * 100))
    const q = clustered(1, 1)[0]
    const pending = store.score(q, { threshold: null, sliceMs: 0 })
    store.removeSession('s199')
    const result = await pending
    expect(result.some((c) => c.sessionId === 's199')).toBe(false)
    let cancel = false
    const cancelled = store.score(q, { threshold: null, sliceMs: 0, isCancelled: () => cancel })
    cancel = true
    await expect(cancelled).rejects.toBeInstanceOf(VectorStoreCancelledError)
  })

  /** 2'000 Sitzungen à 33 Abschnitte = 66'000 × 768 int8 (Bestand von NFR 2). */
  function fullStore(): VectorStore {
    const store = new VectorStore(null)
    const r = rng(3)
    // Ein Vorrat verschiedener Vektoren statt 50 Mio. Zufallszahlen — der
    // Aufbau dauerte unter CPU-Last länger als das Testzeitlimit.
    const pool = Array.from({ length: 257 }, () =>
      Int8Array.from({ length: DIM }, () => Math.round(r() * 254 - 127))
    )
    for (let s = 0; s < 2000; s++) {
      store.putSession(
        `s${s}`,
        Array.from({ length: 33 }, (_, i) => ({
          chunkId: s * 33 + i,
          field: 'body' as const,
          ord: i,
          paraFrom: i,
          paraTo: i,
          vec: pool[(s * 33 + i) % pool.length]
        }))
      )
    }
    expect(store.chunkCount).toBe(66_000)
    return store
  }

  /** Zählt, wie oft der Event-Loop während `run` zum Zug kommt, und die längste Strecke dazwischen. */
  async function measureLoop(run: () => Promise<unknown>): Promise<{
    ticks: number
    maxGap: number
    total: number
  }> {
    let last = performance.now()
    let maxGap = 0
    let ticks = 0
    let ticking = true
    const tick = (): void => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      ticks++
      if (ticking) setImmediate(tick)
    }
    setImmediate(tick)
    const started = performance.now()
    await run()
    const total = performance.now() - started
    ticking = false
    return { ticks, maxGap, total }
  }

  // Strukturell und lastunabhängig: mit einer Uhr, die pro Abfrage genau 1 ms
  // weiterläuft, muss score() nach jeder überschrittenen Scheibe den Event-Loop
  // freigeben — bei 2'000 Sitzungen also rund 2'000 / (SEARCH_COSINE_SLICE_MS + 1) Mal.
  it('yields to the event loop after every slice, independent of machine speed (fake clock)', async () => {
    const store = fullStore()
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => ++clock)
    let ticks = 0
    let ticking = true
    const tick = (): void => {
      ticks++
      if (ticking) setImmediate(tick)
    }
    setImmediate(tick)
    try {
      await store.score(clustered(1, 5)[0], { threshold: 0.99 })
    } finally {
      ticking = false
      now.mockRestore()
    }
    const expected = Math.floor(2000 / (SEARCH_COSINE_SLICE_MS + 1))
    expect(ticks).toBeGreaterThanOrEqual(expected - 2)
  }, 60_000)

  // Echte Messung über 66'000 Vektoren: geloggt; die Grenze ist relativ zur
  // Gesamtdauer, damit CPU-Last (die beides gleich streckt) sie nicht reisst.
  // Ohne Scheiben wäre die längste Strecke die ganze Rechnung.
  it('measures cosine over 66,000 × 768 int8 vectors without blocking the main process for long', async () => {
    const store = fullStore()
    const q = clustered(1, 5)[0]
    let scored: unknown[] = []
    const { maxGap, total, ticks } = await measureLoop(async () => {
      scored = await store.score(q, { threshold: 0.99 })
    })
    console.log(
      `[VectorStore] 66'000 × 768 int8: ${total.toFixed(1)} ms gesamt, längste Strecke ${maxGap.toFixed(1)} ms, ${ticks} Pausen, ${(store.bytes / 1024 ** 2).toFixed(1)} MiB`
    )
    expect(scored.length).toBe(0)
    expect(maxGap).toBeLessThan(Math.max(total / 2, 4 * SEARCH_COSINE_SLICE_MS))
  }, 60_000)
})

describe('VectorStore with the database', () => {
  let rt: SearchRuntime | null = null
  afterEach(() => rt?.dispose())

  async function seeded() {
    const db = createSearchTestDb()
    const docs = new Map<string, unknown>()
    for (const id of ['a', 'b']) {
      addIndexedSession(db, docs, { id, title: `Titel ${id}` }, [
        { speaker: 'A', text: `Text der Sitzung ${id} über Schlaf und Arbeit.` }
      ])
    }
    const service = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => false,
        embedDocuments: async (texts) => texts.map((t) => fakeEmbed(t))
      }
    })
    indexAll(service)
    await service.runVectorPhaseToEnd()
    return { db, docs, service }
  }

  it('loads only the active vector generation of the current model', async () => {
    const { db } = await seeded()
    const store = new VectorStore(db)
    await store.load('test-model')
    expect(store.sessionCount).toBe(2)
    const other = new VectorStore(db)
    await other.load('anderes-modell')
    expect(other.sessionCount).toBe(0)
    db.close()
  })

  it('a deleted (marked) session is gone from memory at once', async () => {
    const { db } = await seeded()
    rt = createSearchRuntime(db, {
      isProcessingActive: () => false,
      workerOverrides: { resolveModel: () => TEST_MODEL }
    })
    await rt.store.load('test-model')
    expect(rt.store.has('a')).toBe(true)
    // Echter Löschpfad: Markierung + Meldung, synchron
    new SessionService(db).deleteSession('a')
    expect(rt.store.has('a')).toBe(false)
    expect(rt.store.has('b')).toBe(true)
    // Auch ein erneutes Lesen bringt sie nicht zurück
    rt.store.refreshSession('a')
    expect(rt.store.has('a')).toBe(false)
    db.close()
  })

  it('follows commits of the vector phase synchronously while loaded', async () => {
    const { db, docs } = await seeded()
    const store = new VectorStore(db)
    await store.load('test-model')
    addIndexedSession(db, docs, { id: 'c' }, [{ text: 'Neue Sitzung über Ferien am Meer.' }])
    const service = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => TEST_MODEL,
        isProcessingActive: () => false,
        embedDocuments: async (texts) => texts.map((t) => fakeEmbed(t)),
        onSessionVectorsChanged: (id) => store.refreshSession(id)
      }
    })
    indexAll(service)
    expect(store.has('c')).toBe(false)
    await service.runVectorPhaseToEnd()
    expect(store.has('c')).toBe(true)
    store.release()
    expect(store.sessionCount).toBe(0)
    expect(store.isLoaded).toBe(false)
    db.close()
  })
})
