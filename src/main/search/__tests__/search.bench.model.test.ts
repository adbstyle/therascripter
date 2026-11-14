// @vitest-environment node
import { describe, it, expect, vi, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SearchWorker } from '../SearchWorker'
import { SearchIndexService } from '../SearchIndexService'
import { SearchService } from '../SearchService'
import { buildSearchSections, sectionEmbeddingText } from '../chunker'
import { quantizeVector, vectorToBlob } from '../VectorStore'
import { createSearchRuntime, warmupSearch } from '../searchRuntime'
import type { SearchModelInfo } from '../searchModel'
import { SearchIndexRepository } from '../../db/repositories/SearchIndexRepository'
import { MODEL_DEFINITIONS } from '../../../shared/model-catalog'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { readFixtureDocs, type FixtureDoc } from './chunker-fixture-docs'
import { insertSession } from './helpers'
import { DEFAULT_REFERENCE_DIR, loadQueries } from './referenceSet'

// Leistungs- und Speichermessung der ECHTEN Suche (#209 AK 14/15, PR S6) auf
// einem Bestand von 2'000 Einträgen — nur mit echtem Modell UND
// THERASCRIPT_SEARCH_BENCH=1 (`npm run bench:search`), dauert ~3–5 min. Über das
// npm-Skript ohne Modell oder Python: rot mit Meldung statt «übersprungen».
//
// Bestand: jede zehnte ein PDF-Bericht (1'500 Wörter), sonst 50-Minuten-
// Sitzungen (7'550 Wörter, 151 Wörter/min aus ADR-008), zusammengesetzt aus
// ganzen Absätzen des Referenz-Sets samt Sprecher-Knoten und Chips — echte
// Sätze und Namen im Trigramm-Index. Vektoren synthetisch wie im Spike: die
// echten Vektoren der 148 Referenz-Abschnitte, je Abschnitt einer davon mit
// etwas Rauschen (int8 wie in der App). Aufbereitung einer Sitzung, Zeit ab
// `search:open` und Speicher werden mit dem echten Suchprozess gemessen.
// Nicht auf einem 8-GB-Mac gemessen.

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../services/ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('x'),
  getModelById: vi.fn().mockReturnValue({ id: 'x', label: 'x', sha256: '0'.repeat(64) })
}))
vi.mock('../../services/SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))

const MODEL_DIR = process.env.THERASCRIPT_SEARCH_MODEL_DIR
const PYTHON = process.env.THERASCRIPT_SEARCH_PYTHON
const REQUESTED = process.env.THERASCRIPT_SEARCH_BENCH === '1'
const ENABLED = REQUESTED && !!MODEL_DIR && !!PYTHON
const REFERENCE_DIR = process.env.THERASCRIPT_SEARCH_REFERENCE_DIR ?? DEFAULT_REFERENCE_DIR
const SCRIPT = join(__dirname, '..', '..', '..', '..', 'python_sidecar', 'search_service.py')

const DOCS = Number(process.env.THERASCRIPT_SEARCH_BENCH_DOCS ?? 2000)
const SESSION_WORDS = 50 * 151
const REPORT_WORDS = 1500
const WARM_QUERIES = 30
const GiB = 1024 ** 3
const MiB = 1024 ** 2

const catalogEntry = MODEL_DEFINITIONS.find((m) => m.group === 'search')!
const model: SearchModelInfo | null = MODEL_DIR
  ? { dir: MODEL_DIR, modelId: catalogEntry.id, ...catalogEntry.embedding! }
  : null

/** Deterministischer Zufall (mulberry32, wie scripts/search-bench.ts). */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function paragraphWords(paragraph: unknown): number {
  let n = 0
  for (const node of (
    paragraph as { content: Array<{ type: string; text?: string; attrs?: { original?: string } }> }
  ).content) {
    const text = node.type === 'text' ? node.text : node.attrs?.original
    if (text) n += text.split(/\s+/).filter(Boolean).length
  }
  return n
}

/** Dokument aus zufälligen ganzen Absätzen des Referenz-Sets. */
function composeDocument(pool: unknown[], words: number, random: () => number): unknown {
  const content: unknown[] = []
  let n = 0
  while (n < words) {
    const paragraph = pool[Math.floor(random() * pool.length)]
    content.push(paragraph)
    n += paragraphWords(paragraph)
  }
  return { type: 'doc', content }
}

/** phys_footprint eines Prozesses über `footprint` (macOS), in Bytes. */
function footprintOf(pid: number): number | null {
  try {
    const out = execFileSync('/usr/bin/footprint', [String(pid)], { encoding: 'utf-8' })
    const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out)
    if (!m) return null
    const unit = m[2] === 'KB' ? 1024 : m[2] === 'MB' ? MiB : GiB
    return Number(m[1]) * unit
  } catch {
    return null
  }
}

function stats(values: number[]): { median: number; p95: number; max: number } {
  const s = [...values].sort((a, b) => a - b)
  return {
    median: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)],
    max: s[s.length - 1]
  }
}

const ms = (x: number): string => `${x.toFixed(0)} ms`

describe.runIf(REQUESTED && !ENABLED)('search benchmark (requested without model)', () => {
  it('needs THERASCRIPT_SEARCH_MODEL_DIR and THERASCRIPT_SEARCH_PYTHON', () => {
    const missing = [
      !MODEL_DIR && 'THERASCRIPT_SEARCH_MODEL_DIR',
      !PYTHON && 'THERASCRIPT_SEARCH_PYTHON'
    ].filter(Boolean)
    throw new Error(`Messung angefordert, aber es fehlt: ${missing.join(', ')}`)
  })
})

describe.skipIf(!ENABLED)('search benchmark with 2,000 documents (real model)', () => {
  const report: string[] = []
  // Erst im Test anlegen: der describe-Körper läuft auch, wenn er übersprungen wird
  let dir: string | null = null
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    console.log(
      `\n[Messung Suche, ${DOCS} Einträge — M5 Pro, nicht auf 8 GB gemessen]\n${report.join('\n')}\n`
    )
  })

  it('measures preparation, answer times and memory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'therascript-search-bench-'))
    const dbPath = join(dir, 'therascript.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = NORMAL')
    applyTestSchema(db)

    const reference: FixtureDoc[] = readFixtureDocs(REFERENCE_DIR)
    const sessionPool = reference
      .filter((d) => d.type === 'audio')
      .flatMap((d) => d.document.content)
    const reportPool = reference.filter((d) => d.type === 'pdf').flatMap((d) => d.document.content)
    const random = rng(42)
    const docs = new Map<string, unknown>()
    db.transaction(() => {
      for (let i = 0; i < DOCS; i++) {
        const pdf = i % 10 === 9
        const id = `s${String(i).padStart(5, '0')}`
        insertSession(db, {
          id,
          type: pdf ? 'pdf' : 'audio',
          title: pdf ? `Bericht ${i}` : `Sitzung ${i}`,
          createdAt: new Date(Date.parse('2024-01-01') + i * 3_600_000).toISOString()
        })
        docs.set(
          `/docs/${id}.json`,
          composeDocument(
            pdf ? reportPool : sessionPool,
            pdf ? REPORT_WORDS : SESSION_WORDS,
            random
          )
        )
      }
    })()

    // 1. Echter Suchprozess: Vektoren der 148 Referenz-Abschnitte als Vorlage
    const worker = new SearchWorker({
      resolveModel: () => model,
      resolveCommand: () => ({ bin: PYTHON!, args: [SCRIPT] }),
      isProcessingActive: () => false
    })
    const templates: Float32Array[] = []
    for (const doc of reference) {
      const sections = buildSearchSections({
        type: doc.type,
        title: '',
        summary: null,
        document: doc.document
      })
      for (let i = 0; i < sections.length; i += 8) {
        templates.push(
          ...(await worker.embedDocuments(sections.slice(i, i + 8).map(sectionEmbeddingText)))
        )
      }
    }
    expect(templates).toHaveLength(148)

    // 2. Textphase (echt) pro Sitzung
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-11-14T00:00:00.000Z'),
      readDocument: (path) => docs.get(path),
      statDocument: () => null,
      vectors: {
        resolveModel: () => model,
        isProcessingActive: () => false,
        embedDocuments: (texts) => worker.embedDocuments(texts),
        // Wie in der App (searchRuntime): die Aufbereitung hält den Prozess,
        // sonst endete er nach jedem Batch (keine USER-Suche) und lüde neu
        onTick: () => worker.refreshState(),
        onActiveChange: (active) => worker.setIndexing(active)
      }
    })
    const textTimes: number[] = []
    for (;;) {
      const t = performance.now()
      const { indexed, more } = index.runTextPhase(1)
      if (indexed > 0) textTimes.push(performance.now() - t)
      if (!more) break
    }
    const chunks = (db.prepare('SELECT COUNT(*) AS n FROM search_chunks').get() as { n: number }).n
    const textStats = stats(textTimes)
    report.push(
      `Bestand: ${DOCS} Einträge, ${chunks} Abschnitte (inkl. Titel)`,
      `Textphase pro Eintrag: Median ${textStats.median.toFixed(1)} ms, 95 % ${textStats.p95.toFixed(1)} ms, Maximum ${textStats.max.toFixed(1)} ms (ohne Pausen)`
    )

    // 3. Synthetische Vektoren: Vorlage + Rauschen, int8, Generation abschliessen
    const repo = new SearchIndexRepository(db)
    const states = db
      .prepare('SELECT session_id, text_gen FROM search_index_state')
      .all() as Array<{ session_id: string; text_gen: number }>
    db.transaction(() => {
      for (const st of states) {
        repo.beginVectorGeneration(st.session_id, model!.modelId)
        const rows = repo.findPendingVectorChunks(st.session_id, st.text_gen).map((c) => {
          const base = templates[Math.floor(random() * templates.length)]
          const v = new Float32Array(base.length)
          let norm = 0
          for (let k = 0; k < v.length; k++) {
            v[k] = base[k] + (random() - 0.5) * 0.01
            norm += v[k] * v[k]
          }
          norm = Math.sqrt(norm)
          for (let k = 0; k < v.length; k++) v[k] /= norm
          const { q, scale } = quantizeVector(v)
          return { id: c.id, vec: vectorToBlob(q), scale }
        })
        repo.writeVectors(rows)
        expect(
          repo.completeVectorGeneration(st.session_id, st.text_gen, model!.modelId)
        ).toBeDefined()
      }
    })()
    db.pragma('wal_checkpoint(TRUNCATE)')
    report.push(`DB-Datei mit Vektoren: ${(statSync(dbPath).size / 1e6).toFixed(0)} MB`)

    // 4. Vektorphase (echt) für eine weitere 50-Minuten-Sitzung
    insertSession(db, { id: 'neu', type: 'audio', title: 'Neue Sitzung' })
    docs.set('/docs/neu.json', composeDocument(sessionPool, SESSION_WORDS, random))
    let t = performance.now()
    index.runTextPhase(1000)
    const tText = performance.now() - t
    const newChunks = (
      db.prepare(`SELECT COUNT(*) AS n FROM search_chunks WHERE session_id = 'neu'`).get() as {
        n: number
      }
    ).n
    const peakBefore = worker.footprint.peak
    t = performance.now()
    expect(await index.runVectorPhaseToEnd()).toBe(1)
    const tVec = performance.now() - t
    report.push(
      `Aufbereitung einer 50-Minuten-Sitzung (${newChunks} Abschnitte): Textphase ${ms(tText)}, Vektorphase ${(tVec / 1000).toFixed(1)} s (${(tVec / newChunks).toFixed(0)} ms pro Abschnitt, Suchprozess schon geladen)`,
      `phys_footprint Suchprozess beim Aufbereiten: Spitze ${(worker.footprint.peak / GiB).toFixed(2)} GiB (vorher ${(peakBefore / GiB).toFixed(2)} GiB)`
    )
    await worker.stop('test')

    // 5. Exakte Suche (sofort, ohne Modell)
    const queries = loadQueries(REFERENCE_DIR).map((q) => q.text)
    const exactService = new SearchService(db)
    const exactTimes: number[] = []
    for (const query of queries.slice(0, WARM_QUERIES)) {
      const t0 = performance.now()
      exactService.query({ requestId: 1, query, scope: { kind: 'all' } })
      exactTimes.push(performance.now() - t0)
    }
    const exactStats = stats(exactTimes)
    report.push(
      `Exakte Suche (search:query, inkl. Ausschnitte), ${WARM_QUERIES} Anfragen: Median ${ms(exactStats.median)}, 95 % ${ms(exactStats.p95)}, Maximum ${ms(exactStats.max)}`
    )

    // 6. Frischer Suchprozess wie in der App: search:open → erste Antwort nach Bedeutung
    const mainBefore = footprintOf(process.pid)
    const arrayBefore = process.memoryUsage().arrayBuffers
    const rt = createSearchRuntime(db, {
      isProcessingActive: () => false,
      workerOverrides: {
        resolveModel: () => model,
        resolveCommand: () => ({ bin: PYTHON!, args: [SCRIPT] })
      }
    })
    const service = new SearchService(db, { semantic: rt.semanticDeps })
    const t0 = performance.now()
    const warm = warmupSearch(rt)
    const first = await service.semantic({
      requestId: 1,
      query: queries[0],
      scope: { kind: 'all' }
    })
    const tFirst = performance.now() - t0
    await warm
    expect(first.semantic).toBe('complete')
    const mainAfter = footprintOf(process.pid)
    const arrayAfter = process.memoryUsage().arrayBuffers
    report.push(
      `search:open → erste Antwort nach Bedeutung (frischer Suchprozess, Datei-Cache warm): ${(tFirst / 1000).toFixed(2)} s`,
      `Vektorspeicher im Main-Prozess: ${rt.store.chunkCount} Abschnitte, ${(rt.store.bytes / MiB).toFixed(1)} MiB (ArrayBuffer +${((arrayAfter - arrayBefore) / MiB).toFixed(1)} MiB, phys_footprint des Node-Prozesses ${mainBefore && mainAfter ? `+${((mainAfter - mainBefore) / MiB).toFixed(0)} MiB` : 'nicht messbar'})`
    )

    // 7. Weitere Suchen nach Bedeutung (Modell geladen)
    const semanticTimes: number[] = []
    let documents = 0
    for (let i = 1; i <= WARM_QUERIES; i++) {
      const t1 = performance.now()
      const result = await service.semantic({
        requestId: 1 + i,
        query: queries[i % queries.length],
        scope: { kind: 'all' }
      })
      semanticTimes.push(performance.now() - t1)
      expect(result.semantic).toBe('complete')
      documents += result.results.length
    }
    const semStats = stats(semanticTimes)
    report.push(
      `Suche nach Bedeutung (search:semantic, inkl. exakter Treffer, Ranking, Ausschnitte), ${WARM_QUERIES} Anfragen: Median ${ms(semStats.median)}, 95 % ${ms(semStats.p95)}, Maximum ${ms(semStats.max)}; im Mittel ${(documents / WARM_QUERIES).toFixed(1)} Dokumente`,
      `phys_footprint Suchprozess bei den Suchen: zuletzt ${((rt.worker.footprint.last ?? 0) / GiB).toFixed(2)} GiB, Spitze ${(rt.worker.footprint.peak / GiB).toFixed(2)} GiB`
    )
    expect(semStats.max).toBeLessThan(2_000)
    expect(rt.worker.footprint.peak).toBeLessThan(3.5 * GiB)
    await rt.worker.stop('test')
    rt.dispose()
    db.close()
  }, 1_800_000)
})
