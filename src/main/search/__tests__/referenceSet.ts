import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildUnits } from '../chunker'
import { filterAndLimit, rankDocuments, type ChunkCandidate } from '../ranking'
import { SEARCH_MAX_DOCUMENT_RESULTS, SEARCH_SEMANTIC_FIELDS } from '../../../shared/search-config'
import type { SearchField } from '../../../shared/types/Search'

/**
 * Referenz-Set der Suche (Spike #208, `tests/fixtures/search-reference/`):
 * Anfragen, Relevanzurteile und die Metriken von `scripts/search-spike.py` —
 * Zeile für Zeile portiert, damit der Abnahmetest
 * (`reference-set.model.test.ts`) mit dem Zielwert vergleichbar ist:
 *
 * - nDCG@10 auf Abschnittsebene, Note eines Abschnitts = höchste Note seiner
 *   Units (`query_metrics`, `cmd_quality_one`);
 * - nur Anfragen mit Urteilen zählen; Anfragen ohne Urteile vom Typ
 *   `negativ` liefern nur ihren Spitzenwert für die Trennung (AUC);
 * - 95 %-CI per Bootstrap über die Anfragen mit Pythons `random.Random(7)`
 *   (`bootstrap_ci`) — der Mersenne-Twister ist nachgebaut, damit dieselben
 *   Werte dieselben Grenzen ergeben (`referenceMetrics.test.ts` prüft das
 *   gegen `results/quality.json` des Spikes).
 *
 * Dazu die Kalibrierung der Schwelle (#209 AK 6): aus den Kosinuswerten
 * aller Abschnitte und den exakten Treffern jeder Anfrage berechnet, für die
 * Suche nach Bedeutung allein und für die Produktiv-Rangfolge (exakte Treffer
 * zuerst, `rankDocuments`). Auch von `scripts/search-calibrate.ts` benutzt.
 */

export const DEFAULT_REFERENCE_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'search-reference'
)

export interface ReferenceQuery {
  id: string
  type: string
  text: string
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

export function loadQueries(dir: string): ReferenceQuery[] {
  return readJsonl<ReferenceQuery>(join(dir, 'queries.jsonl')).map((q) => ({
    id: q.id,
    type: q.type,
    text: q.text
  }))
}

/** Wie `load_qrels`: nur Noten > 0; nicht gelistete Units gelten als 0. */
export function loadQrels(dir: string): Map<string, Map<string, number>> {
  const qrels = new Map<string, Map<string, number>>()
  for (const row of readJsonl<{ q: string; unit: string; grade: number }>(
    join(dir, 'qrels.jsonl')
  )) {
    const grade = Number(row.grade)
    if (grade <= 0) continue
    const rels = qrels.get(row.q) ?? new Map<string, number>()
    rels.set(row.unit, grade)
    qrels.set(row.q, rels)
  }
  return qrels
}

/**
 * Unit-IDs des Spikes (`<doc>:<beitrag>.<teil>`) eines Dokuments, nach
 * Position (`p:s`) — Grundlage der Abbildung gespeicherter Abschnitte
 * (`search_chunks.units`) auf die Relevanzurteile. Der Chunker-Paritätstest
 * belegt, dass Units und Abschnitte dieselben sind wie im Spike.
 */
export function unitIdsByPosition(
  doc: string,
  document: unknown,
  type: 'audio' | 'pdf'
): Map<string, string> {
  const pieceOf = new Map<number, number>()
  const ids = new Map<string, string>()
  for (const unit of buildUnits(document, type)) {
    const piece = pieceOf.get(unit.p) ?? 0
    pieceOf.set(unit.p, piece + 1)
    ids.set(`${unit.p}:${unit.s}`, `${doc}:${String(unit.p).padStart(3, '0')}.${piece}`)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Metriken (search-spike.py)
// ---------------------------------------------------------------------------

export interface QueryMetrics {
  ndcg10: number
  hit5: number
  unitRecall10: number
}

/**
 * Port von `query_metrics`. `ranking`: Abschnitte in Rangfolge; `grades`:
 * Note JEDES bewertbaren Abschnitts (auch 0) — daraus Ideal-DCG und beste
 * Note; `unitsOf`: Unit-IDs eines Abschnitts.
 */
export function queryMetrics(
  ranking: number[],
  grades: Map<number, number>,
  rels: Map<string, number>,
  unitsOf: (chunkId: number) => string[]
): QueryMetrics {
  const top = ranking.slice(0, 10)
  const gains = top.map((id) => grades.get(id) ?? 0)
  const dcg = gains.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 10)
  const idcg = ideal.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0)
  const best = Math.max(...grades.values())
  const relevant = new Set([...rels].filter(([, g]) => g > 0).map(([u]) => u))
  const covered = new Set<string>()
  for (const id of top) for (const u of unitsOf(id)) if (relevant.has(u)) covered.add(u)
  return {
    ndcg10: idcg ? dcg / idcg : 0,
    hit5: top.slice(0, 5).some((id) => (grades.get(id) ?? 0) === best) ? 1 : 0,
    unitRecall10: relevant.size ? covered.size / relevant.size : 0
  }
}

/** `statistics.fmean`. */
export function fmean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Pythons `random.Random` (MT19937, `init_by_array`, `random()` mit 53 Bit),
 * für ein identisches Bootstrap-CI.
 */
export class PyRandom {
  private mt = new Uint32Array(624)
  private mti = 625

  constructor(seed: number) {
    this.initByArray([seed >>> 0])
  }

  private initGenrand(s: number): void {
    const mt = this.mt
    mt[0] = s >>> 0
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30)
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0
    }
    this.mti = 624
  }

  private initByArray(key: number[]): void {
    const mt = this.mt
    this.initGenrand(19650218)
    let i = 1
    let j = 0
    for (let k = Math.max(624, key.length); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30)
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0
      i++
      j++
      if (i >= 624) {
        mt[0] = mt[623]
        i = 1
      }
      if (j >= key.length) j = 0
    }
    for (let k = 623; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30)
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0
      i++
      if (i >= 624) {
        mt[0] = mt[623]
        i = 1
      }
    }
    mt[0] = 0x80000000
  }

  private int32(): number {
    const mt = this.mt
    if (this.mti >= 624) {
      const mag = (y: number): number => (y & 1 ? 0x9908b0df : 0)
      let kk = 0
      for (; kk < 227; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ mag(y)
      }
      for (; kk < 623; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)
        mt[kk] = mt[kk - 227] ^ (y >>> 1) ^ mag(y)
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff)
      mt[623] = mt[396] ^ (y >>> 1) ^ mag(y)
      this.mti = 0
    }
    let y = mt[this.mti++]
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18
    return y >>> 0
  }

  random(): number {
    const a = this.int32() >>> 5
    const b = this.int32() >>> 6
    return (a * 67108864 + b) / 9007199254740992
  }

  /** `random.choices(values, k=k)` ohne Gewichte. */
  choices<T>(values: T[], k: number): T[] {
    const out: T[] = []
    for (let i = 0; i < k; i++) out.push(values[Math.floor(this.random() * values.length)])
    return out
  }
}

/** Port von `bootstrap_ci` (n = 2000, Seed 7). */
export function bootstrapCi(values: number[], n = 2000, seed = 7): [number, number] {
  const rng = new PyRandom(seed)
  const means: number[] = []
  for (let i = 0; i < n; i++) means.push(fmean(rng.choices(values, values.length)))
  means.sort((a, b) => a - b)
  return [means[Math.trunc(0.025 * n)], means[Math.trunc(0.975 * n)]]
}

/** Port von `auc`: Spitzenwerte der Anfragen mit gegen ohne Treffer. */
export function auc(pos: number[], neg: number[]): number | null {
  if (pos.length === 0 || neg.length === 0) return null
  let wins = 0
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

export interface QueryOutcome extends QueryMetrics {
  id: string
  type: string
}

export interface QualitySummary {
  ndcg10: number
  ci95: [number, number]
  n: number
  hit5: number
  hit5Ci95: [number, number]
  byType: Record<string, { ndcg10: number; n: number }>
}

/** Port von `summarize_quality` (plus CI für Hit@5). */
export function summarizeQuality(outcomes: QueryOutcome[]): QualitySummary {
  const ndcg = outcomes.map((o) => o.ndcg10)
  const hit5 = outcomes.map((o) => o.hit5)
  const byType: Record<string, number[]> = {}
  for (const o of outcomes) (byType[o.type] ??= []).push(o.ndcg10)
  return {
    ndcg10: fmean(ndcg),
    ci95: bootstrapCi(ndcg),
    n: ndcg.length,
    hit5: fmean(hit5),
    hit5Ci95: bootstrapCi(hit5),
    byType: Object.fromEntries(
      Object.keys(byType)
        .sort()
        .map((t) => [t, { ndcg10: fmean(byType[t]), n: byType[t].length }])
    )
  }
}

// ---------------------------------------------------------------------------
// Messdaten eines Laufs (Abnahmetest → Kalibrierung)
// ---------------------------------------------------------------------------

/** Ein gespeicherter Abschnitt des Referenz-Sets. */
export interface ReferenceSection {
  chunkId: number
  sessionId: string
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  /** Unit-IDs des Spikes; Titel/Zusammenfassung: keine. */
  units: string[]
}

export interface ReferenceQueryRun {
  id: string
  type: string
  text: string
  /** Kosinus je Abschnitt, in der Reihenfolge von `ReferenceRun.sections`. */
  cosines: number[]
  /** Exakte Treffer-Abschnitte (bm25) der App (`findExactCandidates`). */
  exact: Array<{ chunkId: number; bm25: number }>
}

export interface ReferenceRun {
  sections: ReferenceSection[]
  sortDays: Record<string, string>
  queries: ReferenceQueryRun[]
}

/** Note jedes Text-Abschnitts für eine Anfrage (Titel/Zusammenfassung: 0). */
export function sectionGrades(run: ReferenceRun, rels: Map<string, number>): Map<number, number> {
  const grades = new Map<number, number>()
  for (const s of run.sections) {
    if (s.field !== 'body') continue
    grades.set(s.chunkId, Math.max(0, ...s.units.map((u) => rels.get(u) ?? 0)))
  }
  return grades
}

/**
 * Rein semantische Rangfolge VOR der Schwelle, nur Text-Abschnitte — so ist
 * der Zielwert definiert (148 Abschnitte, Spike). Titel nehmen seit der
 * Sichtprüfung ohnehin nicht an der Suche nach Bedeutung teil
 * (SEARCH_SEMANTIC_FIELDS; ihr Kosinus ist -Infinity).
 */
export function semanticRanking(
  run: ReferenceRun,
  query: ReferenceQueryRun
): Array<{ chunkId: number; cosine: number }> {
  return run.sections
    .map((s, i) => ({ s, cosine: query.cosines[i] }))
    .filter(({ s }) => s.field === 'body')
    .sort((a, b) => b.cosine - a.cosine || a.s.chunkId - b.s.chunkId)
    .map(({ s, cosine }) => ({ chunkId: s.chunkId, cosine }))
}

/**
 * Produktiv-Rangfolge wie `SearchService.semantic`: exakte Kandidaten plus
 * alle Abschnitte mit Kosinus ≥ T, `rankDocuments` (exakte zuerst, dann
 * Kosinus), gruppiert mit bis zu 3 Fundstellen, auf
 * SEARCH_MAX_DOCUMENT_RESULTS geschnitten. `threshold` null = vor der
 * Schwelle.
 */
export function productionDocuments(
  run: ReferenceRun,
  query: ReferenceQueryRun,
  threshold: number | null
): ReturnType<typeof rankDocuments> {
  const byId = new Map(run.sections.map((s) => [s.chunkId, s]))
  const base = (s: ReferenceSection): ChunkCandidate => ({
    chunkId: s.chunkId,
    sessionId: s.sessionId,
    field: s.field,
    ord: s.ord,
    paraFrom: s.paraFrom,
    paraTo: s.paraTo
  })
  const candidates: ChunkCandidate[] = query.exact.map((e) => ({
    ...base(byId.get(e.chunkId)!),
    exact: { bm25: e.bm25 }
  }))
  const semanticFields: readonly SearchField[] = SEARCH_SEMANTIC_FIELDS
  run.sections.forEach((s, i) => {
    const cosine = query.cosines[i]
    // Wie VectorStore: nur Felder der Suche nach Bedeutung (keine Titel)
    if (!semanticFields.includes(s.field) || !Number.isFinite(cosine)) return
    if (threshold === null || cosine >= threshold) {
      candidates.push({ ...base(s), semantic: { cosine } })
    }
  })
  const ranked = rankDocuments(candidates, (id) => run.sortDays[id] ?? '')
  return filterAndLimit(ranked, null, SEARCH_MAX_DOCUMENT_RESULTS).documents
}

/** Angezeigte Fundstellen in Reihenfolge (Abschnitt der Fundstelle, ihre Art). */
export function productionHits(
  run: ReferenceRun,
  query: ReferenceQueryRun,
  threshold: number | null
): Array<{ chunkId: number; kind: 'exact' | 'semantic'; sessionId: string }> {
  return productionDocuments(run, query, threshold).flatMap((d) =>
    d.hits.map((h) => ({ chunkId: h.primary.chunkId, kind: h.kind, sessionId: d.sessionId }))
  )
}

export interface QualityReport {
  /** AK 13: rein semantisch, vor der Schwelle, nur Text-Abschnitte. */
  semantic: QualitySummary & { negAuc: number | null; unitRecall10: number }
  /** Produktiv-Rangfolge (exakte zuerst, gruppiert) bei Schwelle `threshold`. */
  production: QualitySummary & { threshold: number }
  /** Exakte zuerst, ungruppiert, vor der Schwelle (Messung des Architekten: 0.636). */
  exactFirstUngrouped: { ndcg10: number; ci95: [number, number] }
}

export function evaluateRun(
  run: ReferenceRun,
  qrels: Map<string, Map<string, number>>,
  threshold: number
): QualityReport {
  const unitsOf = new Map(run.sections.map((s) => [s.chunkId, s.units]))
  const units = (id: number): string[] => unitsOf.get(id) ?? []
  const sem: QueryOutcome[] = []
  const prod: QueryOutcome[] = []
  const exactFirst: number[] = []
  const pos: number[] = []
  const neg: number[] = []
  for (const q of run.queries) {
    const ranking = semanticRanking(run, q)
    const top = ranking[0]?.cosine ?? Number.NEGATIVE_INFINITY
    const rels = qrels.get(q.id)
    if (!rels || rels.size === 0) {
      if (q.type === 'negativ') neg.push(top)
      continue
    }
    pos.push(top)
    const grades = sectionGrades(run, rels)
    const ids = ranking.map((r) => r.chunkId)
    sem.push({ id: q.id, type: q.type, ...queryMetrics(ids, grades, rels, units) })
    const hits = productionHits(run, q, threshold).map((h) => h.chunkId)
    prod.push({ id: q.id, type: q.type, ...queryMetrics(hits, grades, rels, units) })
    const exactIds = new Set(q.exact.map((e) => e.chunkId))
    const reordered = [
      ...ids.filter((id) => exactIds.has(id)),
      ...ids.filter((id) => !exactIds.has(id))
    ]
    exactFirst.push(queryMetrics(reordered, grades, rels, units).ndcg10)
  }
  return {
    semantic: {
      ...summarizeQuality(sem),
      negAuc: auc(pos, neg),
      unitRecall10: fmean(sem.map((o) => o.unitRecall10))
    },
    production: { ...summarizeQuality(prod), threshold },
    exactFirstUngrouped: { ndcg10: fmean(exactFirst), ci95: bootstrapCi(exactFirst) }
  }
}

// ---------------------------------------------------------------------------
// Kalibrierung der Schwelle (#209 AK 6)
// ---------------------------------------------------------------------------

export interface CalibrationRow {
  threshold: number
  semantic: CalibrationValues
  production: CalibrationValues
}

export interface CalibrationValues {
  /** Anfragen mit Treffern, die mindestens einen relevanten Treffer zeigen. */
  positiveWithRelevant: number
  /** Anfragen ohne Treffer (`negativ`), die nichts zeigen. */
  negativeEmpty: number
  /** Abschnitte mit Note 2 (Paare Anfrage × Abschnitt), die angezeigt werden. */
  recallGrade2: number
  /** Angezeigte Sitzungen bzw. PDF-Dokumente pro Anfrage mit Treffern. */
  documentsPositive: number
  /** … pro Anfrage ohne Treffer. */
  documentsNegative: number
}

/**
 * Für jede Schwelle: Suche nach Bedeutung allein (alle Abschnitte ≥ T, ohne
 * Gruppierung) und Produktiv-Rangfolge (exakte Treffer zuerst, gruppiert mit
 * bis zu 3 Fundstellen pro Dokument — «angezeigt» heisst dort: Abschnitt
 * einer Fundstelle).
 */
export function calibrate(
  run: ReferenceRun,
  qrels: Map<string, Map<string, number>>,
  thresholds: number[]
): CalibrationRow[] {
  const sessionOf = new Map(run.sections.map((s) => [s.chunkId, s.sessionId]))
  return thresholds.map((t) => {
    const acc = {
      semantic: {
        posRel: 0,
        posN: 0,
        negEmpty: 0,
        negN: 0,
        g2Shown: 0,
        g2N: 0,
        docsPos: 0,
        docsNeg: 0
      },
      production: {
        posRel: 0,
        posN: 0,
        negEmpty: 0,
        negN: 0,
        g2Shown: 0,
        g2N: 0,
        docsPos: 0,
        docsNeg: 0
      }
    }
    for (const q of run.queries) {
      const rels = qrels.get(q.id)
      const judged = !!rels && rels.size > 0
      if (!judged && q.type !== 'negativ') continue
      const grades = judged ? sectionGrades(run, rels!) : new Map<number, number>()
      const semShown = run.sections
        .filter((s, i) => s.field === 'body' && q.cosines[i] >= t)
        .map((s) => s.chunkId)
      const prodHits = productionHits(run, q, t)
      const views = {
        semantic: {
          shown: semShown,
          docs: new Set(semShown.map((id) => sessionOf.get(id))).size
        },
        production: {
          shown: prodHits.map((h) => h.chunkId),
          docs: new Set(prodHits.map((h) => h.sessionId)).size
        }
      }
      for (const key of ['semantic', 'production'] as const) {
        const a = acc[key]
        const { shown, docs } = views[key]
        if (judged) {
          a.posN++
          a.docsPos += docs
          if (shown.some((id) => (grades.get(id) ?? 0) > 0)) a.posRel++
          const shownSet = new Set(shown)
          for (const [id, g] of grades) {
            if (g !== 2) continue
            a.g2N++
            if (shownSet.has(id)) a.g2Shown++
          }
        } else {
          a.negN++
          a.docsNeg += docs
          if (shown.length === 0) a.negEmpty++
        }
      }
    }
    const values = (a: typeof acc.semantic): CalibrationValues => ({
      positiveWithRelevant: a.posRel / a.posN,
      negativeEmpty: a.negEmpty / a.negN,
      recallGrade2: a.g2Shown / a.g2N,
      documentsPositive: a.docsPos / a.posN,
      documentsNegative: a.docsNeg / a.negN
    })
    return { threshold: t, semantic: values(acc.semantic), production: values(acc.production) }
  })
}

const pct = (x: number): string => `${Math.round(x * 100)} %`

/** Kalibriertabelle als Markdown. */
export function calibrationTable(rows: CalibrationRow[]): string {
  const lines = [
    '| T | mit Treffern: relevanter Treffer nach Bedeutung | ohne Treffer: nichts nach Bedeutung | Recall Note 2 (Bedeutung) | Dokumente nach Bedeutung (mit / ohne Treffer) | Produktiv: relevanter Treffer | Produktiv: ohne Treffer leer | Produktiv: Recall Note 2 | Produktiv: Dokumente (mit / ohne) |',
    '|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of rows) {
    const s = r.semantic
    const p = r.production
    lines.push(
      `| ${r.threshold.toFixed(2)} | ${pct(s.positiveWithRelevant)} | ${pct(s.negativeEmpty)} | ${pct(s.recallGrade2)} | ${s.documentsPositive.toFixed(1)} / ${s.documentsNegative.toFixed(1)} | ${pct(p.positiveWithRelevant)} | ${pct(p.negativeEmpty)} | ${pct(p.recallGrade2)} | ${p.documentsPositive.toFixed(1)} / ${p.documentsNegative.toFixed(1)} |`
    )
  }
  return lines.join('\n')
}

/** Schwellen 0.60–0.80 in Schritten von 0.01. */
export function defaultThresholds(): number[] {
  const out: number[] = []
  for (let i = 60; i <= 80; i++) out.push(i / 100)
  return out
}
