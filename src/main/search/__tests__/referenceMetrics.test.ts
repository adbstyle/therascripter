import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_REFERENCE_DIR,
  PyRandom,
  auc,
  bootstrapCi,
  loadQrels,
  loadQueries,
  queryMetrics,
  summarizeQuality
} from './referenceSet'

// Die Metriken des Abnahmetests (#209 AK 13) müssen exakt die des Spikes
// sein (scripts/search-spike.py), sonst ist der Vergleich mit dem Zielwert
// wertlos. Ohne Modell prüfbar: die gespeicherten Ergebnisse pro Anfrage des
// Spikes (results/quality-run1.json) ergeben mit dem Port dieselben Werte
// wie results/quality.json — inklusive Bootstrap-CI (Pythons Mersenne-Twister).

const RESULTS = join(DEFAULT_REFERENCE_DIR, 'results')
const hasResults = existsSync(join(RESULTS, 'quality-run1.json'))

describe('reference set metrics — port of search-spike.py', () => {
  it('reproduces random.Random(7)', () => {
    // python3 -c "import random; r=random.Random(7); print([r.random() for _ in range(3)])"
    const r = new PyRandom(7)
    expect(r.random()).toBe(0.32383276483316237)
    expect(r.random()).toBe(0.15084917392450192)
    expect(r.random()).toBe(0.6509344730398537)
    // random.Random(7).choices(list(range(126)), k=10)
    const values = Array.from({ length: 126 }, (_, i) => i)
    expect(new PyRandom(7).choices(values, 10)).toEqual([40, 19, 82, 9, 67, 46, 7, 63, 4, 54])
  })

  it('computes nDCG@10, Hit@5 and unit recall like query_metrics', () => {
    const grades = new Map([
      [1, 0],
      [2, 2],
      [3, 1],
      [4, 0]
    ])
    const rels = new Map([
      ['u2', 2],
      ['u3', 1]
    ])
    const units = (id: number): string[] => [`u${id}`]
    const m = queryMetrics([1, 2, 3, 4], grades, rels, units)
    const dcg = 2 / Math.log2(3) + 1 / Math.log2(4)
    const idcg = 2 / Math.log2(2) + 1 / Math.log2(3)
    expect(m.ndcg10).toBeCloseTo(dcg / idcg, 12)
    expect(m.hit5).toBe(1)
    expect(m.unitRecall10).toBe(1)
  })

  it.skipIf(!hasResults)(
    'reproduces the target value of the spike from its per-query results',
    () => {
      const run = JSON.parse(readFileSync(join(RESULTS, 'quality-run1.json'), 'utf-8')) as {
        per_query: Array<{
          id: string
          type: string
          judged: boolean
          top_score: number
          ndcg10?: number
          hit5?: number
          unit_recall10?: number
        }>
        neg_auc: number
      }
      const want = JSON.parse(readFileSync(join(RESULTS, 'quality.json'), 'utf-8')) as {
        ndcg10: number
        ci95: [number, number]
        n: number
        hit5: number
        neg_auc: number
        by_type: Record<string, { ndcg10: number; n: number }>
      }
      const judged = run.per_query.filter((q) => q.judged)
      const summary = summarizeQuality(
        judged.map((q) => ({
          id: q.id,
          type: q.type,
          ndcg10: q.ndcg10!,
          hit5: q.hit5!,
          unitRecall10: q.unit_recall10!
        }))
      )
      expect(summary.n).toBe(want.n)
      expect(summary.ndcg10).toBeCloseTo(want.ndcg10, 12)
      expect(summary.ci95[0]).toBeCloseTo(want.ci95[0], 12)
      expect(summary.ci95[1]).toBeCloseTo(want.ci95[1], 12)
      expect(summary.hit5).toBeCloseTo(want.hit5, 12)
      for (const [type, v] of Object.entries(want.by_type)) {
        expect(summary.byType[type].n).toBe(v.n)
        expect(summary.byType[type].ndcg10).toBeCloseTo(v.ndcg10, 12)
      }
      // Trennung: Spitzenwerte der Anfragen mit Urteilen gegen die vom Typ negativ
      const pos = judged.map((q) => q.top_score)
      const neg = run.per_query
        .filter((q) => !q.judged && q.type === 'negativ')
        .map((q) => q.top_score)
      expect(auc(pos, neg)).toBeCloseTo(want.neg_auc, 12)
      // Zielwert = untere CI-Grenze, auf zwei Stellen abgerundet
      expect(Math.floor(summary.ci95[0] * 100) / 100).toBe(0.52)
    }
  )

  it('has judgements for every query with hits and none for the negative ones', () => {
    if (!existsSync(join(DEFAULT_REFERENCE_DIR, 'queries.jsonl'))) return
    const queries = loadQueries(DEFAULT_REFERENCE_DIR)
    const qrels = loadQrels(DEFAULT_REFERENCE_DIR)
    expect(queries).toHaveLength(136)
    for (const q of queries) {
      expect(qrels.has(q.id), q.id).toBe(q.type !== 'negativ')
    }
  })

  it('bootstraps deterministically', () => {
    const values = Array.from({ length: 50 }, (_, i) => (i % 7) / 7)
    expect(bootstrapCi(values)).toEqual(bootstrapCi(values))
  })
})
