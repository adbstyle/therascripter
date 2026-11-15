// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SearchWorker } from '../SearchWorker'
import { SearchIndexService } from '../SearchIndexService'
import { SearchService } from '../SearchService'
import { VectorStore } from '../VectorStore'
import { findExactCandidates, parseQuery } from '../exactSearch'
import type { SearchModelInfo } from '../searchModel'
import { SearchIndexRepository, SEARCH_SORT_DAY } from '../../db/repositories/SearchIndexRepository'
import { MODEL_DEFINITIONS } from '../../../shared/model-catalog'
import { SEARCH_SEMANTIC_THRESHOLD } from '../../../shared/search-config'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { readFixtureDocs } from './chunker-fixture-docs'
import { indexAll, insertSession } from './helpers'
import {
  DEFAULT_REFERENCE_DIR,
  calibrate,
  calibrationTable,
  defaultThresholds,
  evaluateRun,
  loadQrels,
  loadQueries,
  productionDocuments,
  semanticRanking,
  sectionGrades,
  queryMetrics,
  unitIdsByPosition,
  type QualityReport,
  type ReferenceRun,
  type ReferenceSection
} from './referenceSet'

// Abnahmetest der Suche (#209 AK 13, AK 6) gegen das fiktive Referenz-Set
// (tests/fixtures/search-reference, Spike #208) mit den ECHTEN Bausteinen:
// Fixtures → TipTap-Dokumente, wie die App sie nach der Pseudonymisierung
// speichert (ein Absatz pro Beitrag, Sprecher- und Zeit-Knoten, Chips mit
// `original`) → Datei-DB mit den echten Repositories → Textphase → echter
// SearchWorker mit search_service.py → Vektorphase (int8) → für jede
// Anfrage `SearchService.rankChunks` (vor der Schwelle) und die exakten
// Treffer der App → Abbildung der Abschnitte auf die Unit-IDs des Sets →
// Metriken wie scripts/search-spike.py (referenceSet.ts, Port geprüft in
// referenceMetrics.test.ts).
//
// Läuft nur mit
//   THERASCRIPT_SEARCH_MODEL_DIR=<entpacktes Artefakt>
//   THERASCRIPT_SEARCH_PYTHON=<python3 mit torch, tokenizers, safetensors>
// und nur über `npm run test:search-quality` (setzt THERASCRIPT_SEARCH_QUALITY=1);
// in `npm test` skip, nie in der CI. Über das npm-Skript ohne Modell oder
// Python: rot mit Meldung (kein falsches Grün durch «übersprungen»).
// Optional THERASCRIPT_SEARCH_QUALITY_OUT=<datei.json>: Messdaten für
// scripts/search-calibrate.ts; ohne bleibt nichts liegen (temporäre DBs werden gelöscht).

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../services/ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('x'),
  getModelById: vi.fn().mockReturnValue({ id: 'x', label: 'x', sha256: '0'.repeat(64) })
}))
vi.mock('../../services/SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))

const MODEL_DIR = process.env.THERASCRIPT_SEARCH_MODEL_DIR
const PYTHON = process.env.THERASCRIPT_SEARCH_PYTHON
const REFERENCE_DIR = process.env.THERASCRIPT_SEARCH_REFERENCE_DIR ?? DEFAULT_REFERENCE_DIR
const SCRIPT = join(__dirname, '..', '..', '..', '..', 'python_sidecar', 'search_service.py')
/** Nur über `npm run test:search-quality` — nie in `npm test`, auch mit gesetztem Modell. */
const REQUESTED = process.env.THERASCRIPT_SEARCH_QUALITY === '1'
const ENABLED =
  REQUESTED && !!MODEL_DIR && !!PYTHON && existsSync(join(REFERENCE_DIR, 'queries.jsonl'))

/** Zielwert (README des Referenz-Sets): untere CI-Grenze des Spikes, abgerundet. */
const TARGET_NDCG10 = 0.52
/** Messwert des Spikes (sentence-transformers, bf16) — Abweichung > 0.02 ist zu erklären. */
const SPIKE_NDCG10 = 0.5697
const GiB = 1024 ** 3

const catalogEntry = MODEL_DEFINITIONS.find((m) => m.group === 'search')!
const model: SearchModelInfo | null = MODEL_DIR
  ? { dir: MODEL_DIR, modelId: catalogEntry.id, ...catalogEntry.embedding! }
  : null

interface PipelineResult {
  run: ReferenceRun
  log: string[]
}

/** «# a1 | Sandra Meier | Sitzung 1 | 2026-03-04» → Titel und Datum. */
function headerOf(path: string): { title: string; date: string } {
  const header = readFileSync(path, 'utf-8').split('\n')[0].replace(/^#\s*/, '')
  const parts = header.split(' | ')
  return { title: parts[parts.length - 2], date: parts[parts.length - 1] }
}

/** Ein vollständiger Lauf in einem frischen Suchprozess und einer frischen Datei-DB. */
async function runPipeline(label: string): Promise<PipelineResult> {
  const log: string[] = []
  const dir = mkdtempSync(join(tmpdir(), 'therascript-reference-set-'))
  const db = new Database(join(dir, 'therascript.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applyTestSchema(db)
  const worker = new SearchWorker({
    resolveModel: () => model,
    resolveCommand: () => ({ bin: PYTHON!, args: [SCRIPT] }),
    isProcessingActive: () => false
  })
  try {
    const fixtureDocs = readFixtureDocs(REFERENCE_DIR)
    const docs = new Map<string, unknown>()
    for (const doc of fixtureDocs) {
      const folder = doc.type === 'pdf' ? 'reports' : 'sessions'
      const { title, date } = headerOf(join(REFERENCE_DIR, folder, `${doc.id}.txt`))
      insertSession(db, {
        id: doc.id,
        type: doc.type,
        title,
        createdAt: `${date}T09:00:00.000Z`,
        documentDate: doc.type === 'pdf' ? date : null
      })
      docs.set(`/docs/${doc.id}.json`, doc.document)
    }

    const store = new VectorStore(db)
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-11-14T00:00:00.000Z'),
      readDocument: (path) => docs.get(path),
      statDocument: () => null,
      vectors: {
        resolveModel: () => model,
        isProcessingActive: () => false,
        embedDocuments: (texts) => worker.embedDocuments(texts),
        onSessionVectorsChanged: (id) => store.refreshSession(id)
      }
    })
    const service = new SearchService(db, {
      semantic: {
        embedQuery: (text) => worker.embedQuery(text),
        getState: () => worker.getState(),
        store,
        resolveModel: () => model
      }
    })

    let t = performance.now()
    const indexed = indexAll(index)
    log.push(`${label}: Textphase ${indexed} Dokumente in ${(performance.now() - t).toFixed(0)} ms`)
    t = performance.now()
    await worker.ensureStarted('warmup')
    log.push(`${label}: Suchprozess bereit nach ${(performance.now() - t).toFixed(0)} ms`)
    t = performance.now()
    const vectorized = await index.runVectorPhaseToEnd()
    const vecChunks = (
      db.prepare('SELECT COUNT(*) AS n FROM search_chunks WHERE vec IS NOT NULL').get() as {
        n: number
      }
    ).n
    log.push(
      `${label}: Vektorphase ${vectorized} Dokumente, ${vecChunks} Abschnitte in ${(performance.now() - t).toFixed(0)} ms`
    )
    expect(vectorized).toBe(fixtureDocs.length)

    // Abschnitte der aktiven Generation → Unit-IDs des Referenz-Sets
    const repo = new SearchIndexRepository(db)
    const sections: ReferenceSection[] = []
    for (const doc of fixtureDocs) {
      const unitIds = unitIdsByPosition(doc.id, doc.document, doc.type)
      for (const chunk of repo.findActiveChunks(doc.id)) {
        sections.push({
          chunkId: chunk.id,
          sessionId: chunk.sessionId,
          field: chunk.field,
          ord: chunk.ord,
          paraFrom: chunk.paraFrom,
          paraTo: chunk.paraTo,
          units: chunk.units.map((u) => {
            const id = unitIds.get(`${u.p}:${u.s}`)
            if (!id) throw new Error(`Unit ${doc.id} p=${u.p} s=${u.s} ohne ID`)
            return id
          })
        })
      }
    }
    const sortDays = Object.fromEntries(
      (
        db.prepare(`SELECT s.id, ${SEARCH_SORT_DAY} AS d FROM sessions s`).all() as Array<{
          id: string
          d: string
        }>
      ).map((r) => [r.id, r.d])
    )

    const position = new Map(sections.map((s, i) => [s.chunkId, i]))
    const queries: ReferenceRun['queries'] = []
    t = performance.now()
    for (const q of loadQueries(REFERENCE_DIR)) {
      const scored = await service.rankChunks(q.text, { threshold: null })
      const cosines = new Array<number>(sections.length).fill(Number.NEGATIVE_INFINITY)
      for (const c of scored) cosines[position.get(c.chunkId)!] = c.cosine
      // Text und Zusammenfassung haben einen Kosinus, Titel keinen (nur exakte Suche)
      sections.forEach((s, i) =>
        expect(Number.isFinite(cosines[i]), `${q.id} ${s.field}`).toBe(s.field !== 'title')
      )
      const exact = findExactCandidates(db, parseQuery(q.text)).candidates.map((c) => ({
        chunkId: c.chunkId,
        bm25: c.exact!.bm25
      }))
      queries.push({ id: q.id, type: q.type, text: q.text, cosines, exact })
    }
    log.push(`${label}: ${queries.length} Anfragen in ${(performance.now() - t).toFixed(0)} ms`)
    log.push(
      `${label}: phys_footprint Suchprozess zuletzt ${((worker.footprint.last ?? 0) / GiB).toFixed(2)} GiB, Spitze ${(worker.footprint.peak / GiB).toFixed(2)} GiB`
    )
    const run: ReferenceRun = { sections, sortDays, queries }

    // Die Produktiv-Rangfolge der Auswertung ist die von SearchService.semantic
    for (const threshold of [SEARCH_SEMANTIC_THRESHOLD, 0.65, 0.75]) {
      const real = new SearchService(db, {
        semantic: {
          embedQuery: (text) => worker.embedQuery(text),
          getState: () => worker.getState(),
          store,
          resolveModel: () => model,
          threshold
        }
      })
      for (const q of queries) {
        const result = await real.semantic({ requestId: 1, query: q.text, scope: { kind: 'all' } })
        expect(result.semantic).toBe('complete')
        const shape = (field: string, kind: string, focus: unknown): string => {
          const f = focus as { paraFrom?: number; paraTo?: number }
          return `${field}/${kind}/${f.paraFrom ?? '-'}-${f.paraTo ?? '-'}`
        }
        const got = result.results.map(
          (d) => `${d.sessionId}:${d.hits.map((h) => shape(h.field, h.kind, h.focus)).join(',')}`
        )
        const want = productionDocuments(run, q, threshold).map(
          (d) =>
            `${d.sessionId}:${d.hits.map((h) => shape(h.field, h.kind, { paraFrom: h.paraFrom ?? undefined, paraTo: h.paraTo ?? undefined })).join(',')}`
        )
        expect(got, `${q.id} bei T=${threshold}`).toEqual(want)
      }
    }
    log.push(
      `${label}: Produktiv-Rangfolge = SearchService.semantic (T ${[SEARCH_SEMANTIC_THRESHOLD, 0.65, 0.75].join(' / ')})`
    )
    return { run, log }
  } finally {
    await worker.stop('test')
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const f2 = (x: number): string => x.toFixed(3)
const ci = (c: [number, number]): string => `${f2(c[0])}–${f2(c[1])}`

function describeReport(report: QualityReport): string[] {
  const s = report.semantic
  const p = report.production
  return [
    `nDCG@10 (Bedeutung, vor der Schwelle — AK 13): ${f2(s.ndcg10)} (95 %-CI ${ci(s.ci95)}), n = ${s.n}`,
    `Hit@5: ${f2(s.hit5)} (95 %-CI ${ci(s.hit5Ci95)}) · Unit-Recall@10: ${f2(s.unitRecall10)} · Neg-AUC: ${s.negAuc === null ? '–' : f2(s.negAuc)}`,
    `je Anfrageart: ${Object.entries(s.byType)
      .map(([t, v]) => `${t} ${f2(v.ndcg10)} (${v.n})`)
      .join(' · ')}`,
    `exakte zuerst, ungruppiert, vor der Schwelle: ${f2(report.exactFirstUngrouped.ndcg10)} (95 %-CI ${ci(report.exactFirstUngrouped.ci95)})`,
    `Produktiv-Rangfolge (exakte zuerst, Schwelle ${p.threshold.toFixed(2)}, gruppiert, Fundstellen): nDCG@10 ${f2(p.ndcg10)} (95 %-CI ${ci(p.ci95)}), Hit@5 ${f2(p.hit5)} (95 %-CI ${ci(p.hit5Ci95)})`,
    `  je Anfrageart: ${Object.entries(p.byType)
      .map(([t, v]) => `${t} ${f2(v.ndcg10)}`)
      .join(' · ')}`
  ]
}

/** Vergleich mit den Ergebnissen pro Anfrage des Spikes (Ursachensuche bei Abweichungen). */
function compareWithSpike(run: ReferenceRun, qrels: Map<string, Map<string, number>>): string[] {
  const path = join(REFERENCE_DIR, 'results', 'quality-run1.json')
  if (!existsSync(path)) return []
  const spike = JSON.parse(readFileSync(path, 'utf-8')) as {
    per_query: Array<{ id: string; judged: boolean; ndcg10?: number; top3: string[] }>
  }
  const byId = new Map(spike.per_query.map((q) => [q.id, q]))
  const spikeId = new Map(
    run.sections
      .filter((s) => s.field === 'body')
      .map((s) => [s.chunkId, `${s.sessionId}#${String(s.ord).padStart(3, '0')}`])
  )
  const unitsOf = new Map(run.sections.map((s) => [s.chunkId, s.units]))
  let sameTop1 = 0
  let sameTop3 = 0
  const diffs: Array<{ id: string; d: number }> = []
  for (const q of run.queries) {
    const s = byId.get(q.id)
    if (!s) continue
    const top = semanticRanking(run, q).map((r) => spikeId.get(r.chunkId)!)
    if (top[0] === s.top3[0]) sameTop1++
    if (top.slice(0, 3).join() === s.top3.join()) sameTop3++
    const rels = qrels.get(q.id)
    if (!s.judged || !rels) continue
    const ndcg = queryMetrics(
      semanticRanking(run, q).map((r) => r.chunkId),
      sectionGrades(run, rels),
      rels,
      (id) => unitsOf.get(id) ?? []
    ).ndcg10
    diffs.push({ id: q.id, d: ndcg - s.ndcg10! })
  }
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  return [
    `gleicher bester Abschnitt wie im Spike: ${sameTop1}/${run.queries.length}, gleiche Top 3: ${sameTop3}/${run.queries.length}`,
    `grösste Abweichungen nDCG@10 pro Anfrage: ${diffs
      .slice(0, 5)
      .map((x) => `${x.id} ${x.d >= 0 ? '+' : ''}${x.d.toFixed(3)}`)
      .join(', ')}`
  ]
}

if (!ENABLED) {
  describe('search acceptance test against the reference set', () => {
    if (!REQUESTED) {
      it.skip('übersprungen — nur über npm run test:search-quality', () => {})
    } else {
      it('needs the search model and Python (tests/fixtures/search-reference/README.md)', () => {
        const missing = [
          !MODEL_DIR && 'THERASCRIPT_SEARCH_MODEL_DIR',
          !PYTHON && 'THERASCRIPT_SEARCH_PYTHON',
          !existsSync(join(REFERENCE_DIR, 'queries.jsonl')) && `Referenz-Set unter ${REFERENCE_DIR}`
        ].filter(Boolean)
        throw new Error(
          `Abnahmetest angefordert, aber es fehlt: ${missing.join(', ')} — siehe README des Referenz-Sets, «Abnahme der Implementierung»`
        )
      })
    }
  })
} else {
  describe('search acceptance test against the reference set (real model)', () => {
    const qrels = loadQrels(REFERENCE_DIR)
    const out: string[] = []
    let first: PipelineResult
    let report: QualityReport

    beforeAll(async () => {
      first = await runPipeline('Lauf 1')
      out.push(...first.log)
      report = evaluateRun(first.run, qrels, SEARCH_SEMANTIC_THRESHOLD)
      out.push('', ...describeReport(report), ...compareWithSpike(first.run, qrels))
    }, 600_000)

    afterAll(() => {
      console.log(`\n[Abnahme Referenz-Set]\n${out.join('\n')}\n`)
    })

    it('maps the stored sections onto the units of the reference set', () => {
      const body = first.run.sections.filter((s) => s.field === 'body')
      expect(body).toHaveLength(148)
      const units = new Set(body.flatMap((s) => s.units))
      expect(units.size).toBe(1158)
      for (const rels of qrels.values())
        for (const u of rels.keys()) expect(units.has(u), u).toBe(true)
    })

    it('reaches the target nDCG@10 by meaning before the threshold (#209 AK 13)', () => {
      expect(report.semantic.n).toBe(126)
      const deviation = report.semantic.ndcg10 - SPIKE_NDCG10
      if (Math.abs(deviation) > 0.02) {
        out.push(
          `WARNUNG: nDCG@10 weicht um ${deviation.toFixed(3)} vom Spike (${SPIKE_NDCG10}) ab — Ursache suchen`
        )
      }
      expect(report.semantic.ndcg10).toBeGreaterThanOrEqual(TARGET_NDCG10)
    })

    it('repeats with the same value to two decimals in a fresh search process', async () => {
      const second = await runPipeline('Lauf 2')
      out.push('', ...second.log)
      const again = evaluateRun(second.run, qrels, SEARCH_SEMANTIC_THRESHOLD)
      out.push(
        `Wiederholung: nDCG@10 ${f2(again.semantic.ndcg10)} (95 %-CI ${ci(again.semantic.ci95)}), Produktiv ${f2(again.production.ndcg10)}`
      )
      expect(again.semantic.ndcg10.toFixed(2)).toBe(report.semantic.ndcg10.toFixed(2))
      expect(again.semantic.ci95[0].toFixed(2)).toBe(report.semantic.ci95[0].toFixed(2))
    }, 600_000)

    it('prints the calibration table of the threshold (#209 AK 6)', () => {
      const rows = calibrate(first.run, qrels, defaultThresholds())
      out.push(
        '',
        `Kalibrierung (aktuell SEARCH_SEMANTIC_THRESHOLD = ${SEARCH_SEMANTIC_THRESHOLD}):`,
        calibrationTable(rows)
      )
      const file = process.env.THERASCRIPT_SEARCH_QUALITY_OUT
      if (file) {
        writeFileSync(file, JSON.stringify(first.run))
        out.push(`Messdaten: ${file} (npx tsx scripts/search-calibrate.ts ${file})`)
      } else {
        out.push(
          'Messdaten für scripts/search-calibrate.ts: THERASCRIPT_SEARCH_QUALITY_OUT=<datei.json> setzen'
        )
      }
      expect(rows.length).toBeGreaterThan(0)
    })
  })
}
