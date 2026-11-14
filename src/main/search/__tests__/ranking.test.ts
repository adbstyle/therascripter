import { describe, it, expect } from 'vitest'
import {
  compareChunks,
  compareDocuments,
  filterAndLimit,
  pickHits,
  rankDocuments,
  type ChunkCandidate,
  type RankedDocument
} from '../ranking'

function chunk(
  chunkId: number,
  sessionId: string,
  extra: Partial<ChunkCandidate> = {}
): ChunkCandidate {
  return {
    chunkId,
    sessionId,
    field: 'body',
    ord: chunkId,
    paraFrom: chunkId * 10,
    paraTo: chunkId * 10 + 5,
    ...extra
  }
}

const days: Record<string, string> = {
  a: '2026-01-01',
  b: '2026-03-01',
  c: '2026-02-01',
  d: '2026-04-01'
}
const dayOf = (id: string): string => days[id] ?? ''

describe('search ranking', () => {
  it('orders documents by bm25 without a model, then by date (#209 AK 8)', () => {
    const ranked = rankDocuments(
      [
        chunk(1, 'a', { exact: { bm25: -5 } }),
        chunk(2, 'b', { exact: { bm25: -2 } }),
        chunk(3, 'c', { exact: { bm25: -2 } })
      ],
      dayOf
    )
    expect(ranked.map((d) => d.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('puts documents with an exact hit before semantic-only ones, then by cosine (S4 input)', () => {
    const ranked = rankDocuments(
      [
        chunk(1, 'a', { semantic: { cosine: 0.9 } }),
        chunk(2, 'b', { exact: { bm25: -1 }, semantic: { cosine: 0.71 } }),
        chunk(3, 'c', { exact: { bm25: -9 }, semantic: { cosine: 0.7 } }),
        chunk(4, 'd', { semantic: { cosine: 0.8 } })
      ],
      dayOf
    )
    expect(ranked.map((d) => d.sessionId)).toEqual(['b', 'c', 'a', 'd'])
    expect(ranked[2].hits[0].kind).toBe('semantic')
  })

  it('merges the same chunk delivered by exact and semantic search', () => {
    const ranked = rankDocuments(
      [chunk(1, 'a', { exact: { bm25: -1 } }), chunk(1, 'a', { semantic: { cosine: 0.8 } })],
      dayOf
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0].hits).toHaveLength(1)
    expect(ranked[0].maxCosine).toBe(0.8)
    expect(ranked[0].hits[0].kind).toBe('exact')
  })

  it('shows each document once with up to three hits, overlapping sections merged (#209 AK 7)', () => {
    const hits = pickHits([
      chunk(1, 'a', { exact: { bm25: -3 }, paraFrom: 0, paraTo: 4 }),
      // teilt Absatz 4 mit Abschnitt 1 (wiederholte Unit)
      chunk(2, 'a', { exact: { bm25: -2 }, paraFrom: 4, paraTo: 9 }),
      chunk(3, 'a', { exact: { bm25: -1 }, paraFrom: 20, paraTo: 25 }),
      chunk(4, 'a', { exact: { bm25: -1 }, paraFrom: 30, paraTo: 35 }),
      chunk(5, 'a', { exact: { bm25: -0.5 }, paraFrom: 40, paraTo: 45 }),
      chunk(6, 'a', { exact: { bm25: -9 }, field: 'title', paraFrom: null, paraTo: null })
    ])
    expect(hits).toHaveLength(3)
    expect(hits[0].field).toBe('title')
    expect(hits[1].merged.map((m) => m.chunkId)).toEqual([1, 2])
    expect([hits[1].paraFrom, hits[1].paraTo]).toEqual([0, 4])
    expect(hits[2].primary.chunkId).toBe(3)
  })

  it('filters on a dossier AFTER ranking: same order as the search over everything (#211 AK 3)', () => {
    const ranked = rankDocuments(
      ['a', 'b', 'c', 'd'].map((id, i) => chunk(i + 1, id, { exact: { bm25: -10 + i } })),
      dayOf
    )
    const all = filterAndLimit(ranked, null, 100).documents.map((d) => d.sessionId)
    const scoped = filterAndLimit(ranked, new Set(['d', 'b']), 100).documents.map(
      (d) => d.sessionId
    )
    expect(scoped).toEqual(all.filter((id) => id === 'b' || id === 'd'))
    expect(filterAndLimit(ranked, null, 2)).toMatchObject({ truncated: true })
  })
})

describe('compareDocuments / compareChunks — total order (Review PR #226)', () => {
  const doc = (
    sessionId: string,
    bestBm25: number | null,
    maxCosine: number | null,
    hasExact = bestBm25 !== null,
    sortDay = '2026-01-01'
  ): RankedDocument => ({ sessionId, sortDay, hasExact, maxCosine, bestBm25, hits: [] })

  it('orders the minimal example A(bm25 −1, cos 0.9), B(bm25 −2), C(bm25 −3, cos 0.75) as A, C, B', () => {
    const a = doc('A', -1, 0.9)
    const b = doc('B', -2, null)
    const c = doc('C', -3, 0.75)
    for (const input of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
      [c, b, a]
    ]) {
      expect([...input].sort(compareDocuments).map((d) => d.sessionId)).toEqual(['A', 'C', 'B'])
    }
  })

  it('is antisymmetric and transitive on random documents and chunks', () => {
    let seed = 42
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 0xffffffff
    }
    const pick = <T>(values: T[]): T => values[Math.floor(rnd() * values.length)]
    const docs = Array.from({ length: 60 }, (_, i) => {
      const hasExact = rnd() < 0.5
      return doc(
        `s${i}`,
        hasExact ? pick([-1, -2, -3]) : null,
        rnd() < 0.6 ? pick([0.7, 0.75, 0.8]) : null,
        hasExact,
        pick(['2026-01-01', '2026-02-01'])
      )
    })
    const chunks = Array.from({ length: 60 }, (_, i) => ({
      chunkId: i,
      sessionId: 's',
      field: pick(['title', 'summary', 'body'] as const),
      ord: pick([0, 1]),
      paraFrom: 0,
      paraTo: 0,
      exact: rnd() < 0.5 ? { bm25: pick([-1, -2]) } : undefined,
      semantic: rnd() < 0.6 ? { cosine: pick([0.7, 0.8]) } : undefined
    }))
    const check = <T>(items: T[], cmp: (a: T, b: T) => number): void => {
      for (const a of items) {
        for (const b of items) {
          expect(Math.sign(cmp(a, b))).toBe(-Math.sign(cmp(b, a)) || 0)
          for (const c of items.slice(0, 20)) {
            if (cmp(a, b) <= 0 && cmp(b, c) <= 0) expect(cmp(a, c)).toBeLessThanOrEqual(0)
          }
        }
      }
    }
    check(docs, compareDocuments)
    check(chunks, compareChunks)
  })
})
