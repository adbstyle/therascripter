import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SearchWorker } from '../SearchWorker'
import type { LineProcess, LineProcessExit } from '../../utils/line-process'
import type { SearchModelInfo } from '../searchModel'

// Speicherfreigabe (#209 AK 17, Review PR #226 Punkt 6) mit Fake-Timern und
// einem Stub-Prozess: gezählt wird nur die letzte USER-Interaktion; die
// Aufbereitung verlängert den Leerlauf nicht, darf den Prozess aber am Leben
// halten, solange sie läuft.

const MODEL: SearchModelInfo = {
  dir: '/x',
  modelId: 'm',
  dim: 4,
  queryPrompt: '',
  documentPrompt: '',
  maxTokens: 8,
  padMultiple: 8
}
const VEC = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer).toString('base64')
const MIN = 60_000

class StubProcess {
  static footprint = 1
  exitInfo: LineProcessExit | null = null
  private waiters: Array<(e: LineProcessExit) => void> = []
  pid = Math.floor(Math.random() * 1e6)
  weightsLine = null
  start(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ready: true, dim: 4, phys_footprint_bytes: 1 })
  }
  request(msg: { op: string; texts?: string[] }): Promise<Record<string, unknown>> {
    const fp = { phys_footprint_bytes: StubProcess.footprint }
    if (msg.op === 'embed_documents') {
      return Promise.resolve({ vectors: msg.texts!.map(() => VEC), ...fp })
    }
    return Promise.resolve({ vector: VEC, ...fp })
  }
  stop(): Promise<LineProcessExit> {
    if (!this.exitInfo) {
      this.exitInfo = {
        code: 0,
        exitSignal: null,
        stopRequested: true,
        startTimedOut: false,
        stderr: ''
      }
      for (const w of this.waiters.splice(0)) w(this.exitInfo)
    }
    return Promise.resolve(this.exitInfo)
  }
  waitForExit(): Promise<LineProcessExit> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((r) => this.waiters.push(r))
  }
}

let spawned: StubProcess[]
let worker: SearchWorker
let stopped: string[]
let gate: Promise<unknown> | undefined

function create(): void {
  spawned = []
  stopped = []
  worker = new SearchWorker({
    resolveModel: () => MODEL,
    resolveCommand: () => ({ bin: '/bin/true', args: [] }),
    isProcessingActive: () => false,
    createProcess: () => {
      const p = new StubProcess()
      spawned.push(p)
      return p as unknown as LineProcess
    },
    startGate: gate ? () => gate! : undefined,
    restartFootprintBytes: 100
  })
  worker.onStopped((r) => stopped.push(r))
}

const alive = (): boolean =>
  worker.getState().phase === 'ready' || worker.getState().phase === 'busy'
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

describe('SearchWorker — Leerlauf', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    StubProcess.footprint = 1
    gate = undefined
    create()
  })
  afterEach(() => vi.useRealTimers())

  it('ends 5 min after the last USER query', async () => {
    await worker.embedQuery('a')
    await vi.advanceTimersByTimeAsync(5 * MIN - 1)
    expect(alive()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(stopped).toEqual(['idle'])
  })

  it('a later query moves the end; opening the search (warmup) counts as USER interaction', async () => {
    await worker.ensureStarted('warmup')
    await vi.advanceTimersByTimeAsync(3 * MIN)
    await worker.embedQuery('b')
    await vi.advanceTimersByTimeAsync(4 * MIN)
    expect(alive()).toBe(true)
    await vi.advanceTimersByTimeAsync(1 * MIN)
    await flush()
    expect(stopped).toEqual(['idle'])
  })

  it('the preparation does NOT extend the idle time, but keeps the process while it runs', async () => {
    await worker.embedQuery('a')
    worker.setIndexing(true)
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(MIN / 2)
      await worker.embedDocuments(['x', 'y'])
    }
    // 10 min Aufbereitung: der Prozess lebt (läuft die Aufbereitung) …
    expect(alive()).toBe(true)
    // … und endet sofort, wenn sie fertig ist — die letzte Suche liegt 10 min zurück
    worker.setIndexing(false)
    await flush()
    expect(stopped).toEqual(['idle'])
  })

  it('without any USER interaction the process ends right after the preparation', async () => {
    worker.setIndexing(true)
    await worker.embedDocuments(['x'])
    expect(alive()).toBe(true)
    worker.setIndexing(false)
    await flush()
    expect(stopped).toEqual(['idle'])
  })

  it('stays after the preparation while the last USER query is recent, then ends on time', async () => {
    worker.setIndexing(true)
    await worker.embedDocuments(['x'])
    await vi.advanceTimersByTimeAsync(MIN)
    await worker.embedQuery('a')
    await vi.advanceTimersByTimeAsync(MIN)
    worker.setIndexing(false)
    await flush()
    expect(alive()).toBe(true)
    await vi.advanceTimersByTimeAsync(4 * MIN)
    await flush()
    expect(stopped).toEqual(['idle'])
  })

  it('restarts right after a batch above the memory limit while the preparation runs', async () => {
    worker.setIndexing(true)
    await worker.embedDocuments(['x'])
    StubProcess.footprint = 1_000
    await worker.embedDocuments(['y'])
    await flush()
    expect(stopped).toEqual(['memory'])
    expect(spawned).toHaveLength(2)
    expect(alive()).toBe(true)
  })

  it('waits for the tool check before starting Python', async () => {
    let release: () => void = () => {}
    gate = new Promise<void>((r) => (release = r))
    create()
    const start = worker.ensureStarted('warmup')
    await flush()
    expect(spawned).toHaveLength(0)
    release()
    await start
    expect(spawned).toHaveLength(1)
  })
})
