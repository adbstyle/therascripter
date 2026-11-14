// @vitest-environment node
import { describe, it, expect, vi, afterAll } from 'vitest'
import { join } from 'path'
import Database from 'better-sqlite3'
import { SearchWorker } from '../SearchWorker'
import { SearchIndexService } from '../SearchIndexService'
import { SearchService } from '../SearchService'
import { VectorStore } from '../VectorStore'
import type { SearchModelInfo } from '../searchModel'
import { MODEL_DEFINITIONS } from '../../../shared/model-catalog'
import { TaskQueueService } from '../../services/TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { addIndexedSession, createSearchTestDb, indexAll } from './helpers'
import { applyTestSchema } from '../../db/__tests__/test-utils'

// Mit ECHTEM Suchmodell (PR S4): läuft nur mit
//   THERASCRIPT_SEARCH_MODEL_DIR=<entpacktes Artefakt>
//   THERASCRIPT_SEARCH_PYTHON=<python3 mit torch, tokenizers, safetensors>
// sonst skip. Misst Start, Anfragen, Speicher und Vektorphase und prüft
// Leerlauf-Stopp, Stopp durch den Task-Hook und Neustart.

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../services/ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('x'),
  getModelById: vi.fn().mockReturnValue({ id: 'x', label: 'x', sha256: '0'.repeat(64) })
}))
vi.mock('../../services/SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))

const MODEL_DIR = process.env.THERASCRIPT_SEARCH_MODEL_DIR
const PYTHON = process.env.THERASCRIPT_SEARCH_PYTHON
const SCRIPT = join(__dirname, '..', '..', '..', '..', 'python_sidecar', 'search_service.py')

// Konfiguration aus dem Katalog (auch unveröffentlicht), Ort aus der Variable
const catalogEntry = MODEL_DEFINITIONS.find((m) => m.group === 'search')!
const model: SearchModelInfo | null = MODEL_DIR
  ? { dir: MODEL_DIR, modelId: catalogEntry.id, ...catalogEntry.embedding! }
  : null

const GiB = 1024 ** 3
const report: string[] = []

const SESSIONS: Array<{ id: string; turns: string[] }> = [
  {
    id: 'schlaf',
    turns: [
      'Wie haben Sie seit dem letzten Termin geschlafen?',
      'Schlecht. Ich wache jede Nacht gegen drei Uhr auf und liege dann wach bis zum Morgen. Die Gedanken kreisen um die Arbeit und um meine Mutter.',
      'Was tun Sie, wenn Sie wach liegen?',
      'Meistens schaue ich aufs Handy, was es vermutlich schlimmer macht.'
    ]
  },
  {
    id: 'trauer',
    turns: [
      'Sie haben erwähnt, dass Ihr Vater im Frühling gestorben ist.',
      'Ja. Ich habe das Gefühl, ich hätte mehr Zeit mit ihm verbringen sollen. Manchmal greife ich zum Telefon, um ihn anzurufen, und dann fällt es mir wieder ein.',
      'Das klingt nach einem grossen Verlust.'
    ]
  },
  {
    id: 'arbeit',
    turns: [
      'Im Team gibt es seit Wochen Spannungen. Mein Vorgesetzter kritisiert mich vor allen anderen.',
      'Wie reagieren Sie darauf?',
      'Ich sage nichts und ärgere mich danach stundenlang. Ich überlege, die Stelle zu wechseln.'
    ]
  }
]

describe.skipIf(!MODEL_DIR || !PYTHON)('SearchWorker with the real search model', () => {
  const workers: SearchWorker[] = []
  afterAll(async () => {
    for (const w of workers) await w.stop('test')
    console.log(`\n[Messung Suchprozess]\n${report.join('\n')}\n`)
  })

  function createWorker(isProcessingActive: () => boolean, idleMs?: number): SearchWorker {
    const worker = new SearchWorker({
      resolveModel: () => model,
      resolveCommand: () => ({ bin: PYTHON!, args: [SCRIPT] }),
      isProcessingActive,
      idleMs
    })
    workers.push(worker)
    return worker
  }

  it('indexes sessions, searches by meaning, stops when idle and restarts', async () => {
    const db = createSearchTestDb()
    const docs = new Map<string, unknown>()
    for (const s of SESSIONS) {
      addIndexedSession(
        db,
        docs,
        { id: s.id, title: `Sitzung ${s.id}` },
        s.turns.map((text, i) => ({ speaker: i % 2 === 0 ? ('A' as const) : ('B' as const), text }))
      )
    }
    const worker = createWorker(() => false, 4_000)
    const store = new VectorStore(db)
    const index = new SearchIndexService(db, {
      now: () => Date.parse('2026-06-01T00:00:00.000Z'),
      readDocument: (p) => docs.get(p),
      vectors: {
        resolveModel: () => model,
        isProcessingActive: () => false,
        embedDocuments: (t) => worker.embedDocuments(t),
        onSessionVectorsChanged: (id) => store.refreshSession(id)
      }
    })
    const service = new SearchService(db, {
      semantic: {
        embedQuery: (t) => worker.embedQuery(t),
        getState: () => worker.getState(),
        store,
        resolveModel: () => model
      }
    })
    indexAll(index)

    // Kalt: warmup bis zur ersten Antwort nach Bedeutung
    const t0 = performance.now()
    await worker.ensureStarted('warmup')
    const tReady = performance.now() - t0
    const first = await service.semantic({
      requestId: 1,
      query: 'Probleme beim Einschlafen',
      scope: { kind: 'all' }
    })
    const tFirst = performance.now() - t0
    report.push(`warmup → bereit (kalt): ${tReady.toFixed(0)} ms`)
    report.push(`warmup → erste Antwort nach Bedeutung (kalt): ${tFirst.toFixed(0)} ms`)
    // Noch ohne Vektoren: nur exakte Treffer möglich
    expect(first.semantic).toBe('complete')

    // Vektorphase
    const tv = performance.now()
    const done = await index.runVectorPhaseToEnd()
    const tVec = performance.now() - tv
    const chunks = (
      db.prepare('SELECT COUNT(*) AS n FROM search_chunks WHERE vec IS NOT NULL').get() as {
        n: number
      }
    ).n
    expect(done).toBe(SESSIONS.length)
    report.push(
      `Vektorphase: ${done} Sitzungen, ${chunks} Abschnitte in ${tVec.toFixed(0)} ms (${(tVec / done).toFixed(0)} ms pro Sitzung, ${(tVec / chunks).toFixed(0)} ms pro Abschnitt)`
    )

    // Warm: weitere Anfragen
    const queries = [
      'Probleme beim Einschlafen',
      'Tod eines Elternteils',
      'Streit mit dem Chef',
      'nachts wach liegen',
      'Kündigung überlegen'
    ]
    const expected = ['schlaf', 'trauer', 'arbeit', 'schlaf', 'arbeit']
    const latencies: number[] = []
    for (let i = 0; i < queries.length; i++) {
      const t = performance.now()
      const result = await service.semantic({
        requestId: 10 + i,
        query: queries[i],
        scope: { kind: 'all' }
      })
      latencies.push(performance.now() - t)
      expect(result.semantic).toBe('complete')
      expect(result.results[0]?.sessionId).toBe(expected[i])
    }
    report.push(
      `weitere Anfragen (warm, inkl. Ranking): ${latencies.map((l) => l.toFixed(0)).join(', ')} ms`
    )
    const ranked = await service.rankChunks('Tod eines Elternteils', { threshold: null })
    report.push(
      `Kosinus «Tod eines Elternteils»: bester ${ranked[0].cosine.toFixed(3)} (${ranked[0].sessionId}), schlechtester ${ranked.at(-1)!.cosine.toFixed(3)}`
    )
    report.push(
      `phys_footprint Suchprozess: zuletzt ${((worker.footprint.last ?? 0) / GiB).toFixed(2)} GiB, Spitze ${(worker.footprint.peak / GiB).toFixed(2)} GiB`
    )
    expect(worker.footprint.peak).toBeLessThan(3.5 * GiB)

    // Leerlauf-Stopp (hier 4 s statt 5 min)
    const pid = worker.pid!
    await new Promise((r) => setTimeout(r, 6_000))
    expect(worker.getState().phase).toBe('stopped')
    expect(() => process.kill(pid, 0)).toThrow()
    report.push('Leerlauf-Stopp: Prozess nach der Leerlaufzeit beendet')

    // Neustart bei der nächsten Anfrage (Datei-Cache warm)
    const t1 = performance.now()
    const again = await service.semantic({
      requestId: 99,
      query: 'Schlafstörung',
      scope: { kind: 'all' }
    })
    report.push(
      `Neustart → Antwort (warmer Datei-Cache): ${(performance.now() - t1).toFixed(0)} ms`
    )
    expect(again.results[0]?.sessionId).toBe('schlaf')
    await worker.stop('test')
    db.close()
  }, 300_000)

  it('a task of the queue starts only after the search process has exited', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    const queue = new TaskQueueService(db)
    const worker = createWorker(() => queue.hasActiveWork())
    await worker.ensureStarted('warmup')
    const pid = worker.pid!
    queue.setBeforeTaskHook(() => worker.stop('processing'))
    const seen: boolean[] = []
    const exec = {
      async execute(): Promise<void> {
        let alive = true
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
        seen.push(alive)
      }
    }
    for (const t of ['extraction', 'ocr', 'anonymization', 'summarization'] as const) {
      queue.registerExecutor(t, exec)
    }
    const session = new SessionRepository(db).create({ title: 'P', type: 'pdf', status: 'queued' })
    const t = performance.now()
    queue.enqueuePipeline(session.id, 'pdf')
    queue.start()
    await new Promise((r) => setTimeout(r, 4_000))
    queue.stop()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((a) => !a)).toBe(true)
    report.push(
      `Stopp durch Task-Hook: Suchprozess beendet, bevor der Task begann (${seen.length} Tasks, erster Task nach ≤ ${(performance.now() - t).toFixed(0)} ms Beobachtungsfenster)`
    )
    db.close()
  }, 120_000)
})
