// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { join } from 'path'
import { SearchWorker, SearchWorkerUnavailableError, type SearchWorkerDeps } from '../SearchWorker'
import { LineProcess, type LineProcessOptions } from '../../utils/line-process'
import type { SearchModelInfo } from '../searchModel'
import type { SearchProcessState } from '../../../shared/types/Search'

// Lebenszyklus des Suchprozesses mit einem echten Fake-Dienst (Node-Skript mit
// dem Protokoll von search_service.py).

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))

const FAKE = join(__dirname, '..', '..', 'utils', '__tests__', 'fixtures', 'fake-line-service.mjs')

const MODEL: SearchModelInfo = {
  dir: '/nicht/benutzt',
  modelId: 'fake-model',
  dim: 768,
  queryPrompt: 'q: ',
  documentPrompt: 'd: ',
  maxTokens: 1024,
  padMultiple: 128
}

const workers: SearchWorker[] = []

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface Harness {
  worker: SearchWorker
  spawned: LineProcess[]
  states: SearchProcessState[]
  processing: { active: boolean }
  model: { info: SearchModelInfo | null }
  clock: { now: number }
}

function create(env: Record<string, string> = {}, deps: Partial<SearchWorkerDeps> = {}): Harness {
  const spawned: LineProcess[] = []
  const processing = { active: false }
  const model = { info: MODEL as SearchModelInfo | null }
  const clock = { now: 1_000_000 }
  const worker = new SearchWorker({
    resolveModel: () => model.info,
    resolveCommand: () => ({ bin: process.execPath, args: [FAKE] }),
    isProcessingActive: () => processing.active,
    checkToolBlocked: async () => 'none' as const,
    createProcess: (opts: LineProcessOptions) => {
      const proc = new LineProcess({ ...opts, env: { ...opts.env, ...env } })
      spawned.push(proc)
      return proc
    },
    now: () => clock.now,
    eofGraceMs: 300,
    killGraceMs: 300,
    startTimeoutMs: 5_000,
    ...deps
  })
  const states: SearchProcessState[] = []
  worker.onStateChange((s) => states.push(s))
  workers.push(worker)
  return { worker, spawned, states, processing, model, clock }
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop('test')
})

function norm(v: Float32Array): number {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

describe('SearchWorker', () => {
  it('starts on warmup, answers queries and documents, passes model args and offline env', async () => {
    const h = create()
    await h.worker.ensureStarted('warmup')
    expect(h.worker.getState()).toEqual({ phase: 'ready', reason: null })
    const q = await h.worker.embedQuery('Schlafprobleme')
    expect(q).toHaveLength(768)
    expect(norm(q)).toBeCloseTo(1, 4)
    const docs = await h.worker.embedDocuments(['eins', 'zwei'])
    expect(docs).toHaveLength(2)
    const proc = h.spawned[0]
    const env = (await proc.request({ op: 'env' })) as { env: Record<string, string> }
    expect(env.env.HF_HUB_OFFLINE).toBe('1')
    expect(env.env.PYTHONDONTWRITEBYTECODE).toBe('1')
    expect(h.states.map((s) => s.phase)).toEqual(
      expect.arrayContaining(['starting', 'ready', 'busy'])
    )
  })

  it('shares one start between concurrent callers (single flight)', async () => {
    const h = create({ FAKE_READY_DELAY_MS: '200' })
    await Promise.all([
      h.worker.ensureStarted('warmup'),
      h.worker.embedQuery('a'),
      h.worker.embedQuery('b')
    ])
    expect(h.spawned).toHaveLength(1)
  })

  it('refuses to start while processing is active or the model is missing', async () => {
    const h = create()
    h.processing.active = true
    await expect(h.worker.ensureStarted('query')).rejects.toMatchObject({ reason: 'processing' })
    expect(h.worker.getState().reason).toBe('processing')
    h.processing.active = false
    h.model.info = null
    await expect(h.worker.embedQuery('x')).rejects.toMatchObject({ reason: 'model-missing' })
    expect(h.spawned).toHaveLength(0)
  })

  it('stops after the idle time without queries and frees the process', async () => {
    const h = create({}, { idleMs: 200, now: Date.now })
    const stopped: string[] = []
    h.worker.onStopped((r) => stopped.push(r))
    await h.worker.embedQuery('x')
    const pid = h.worker.pid
    await new Promise((r) => setTimeout(r, 150))
    // Eine weitere Anfrage verschiebt den Leerlauf
    await h.worker.embedQuery('y')
    await new Promise((r) => setTimeout(r, 150))
    expect(alive(pid)).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(stopped).toEqual(['idle'])
    expect(alive(pid)).toBe(false)
    expect(h.worker.getState().phase).toBe('stopped')
  })

  it('stop() during startup ends the process; the pending start is rejected', async () => {
    const h = create({ FAKE_READY_DELAY_MS: '3000' })
    const start = h.worker.ensureStarted('warmup').catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 100))
    const pid = h.spawned[0].pid
    h.processing.active = true
    await h.worker.stop('processing')
    const err = await start
    expect(err).toBeInstanceOf(SearchWorkerUnavailableError)
    expect(err).toMatchObject({ reason: 'processing' })
    expect(alive(pid)).toBe(false)
    // idempotent
    await h.worker.stop('processing')
    expect(h.worker.getState()).toEqual({ phase: 'stopped', reason: 'processing' })
  })

  it('restarts between two calls when phys_footprint exceeds the limit', async () => {
    const h = create(
      { FAKE_FOOTPRINT_START: String(1024 ** 3), FAKE_FOOTPRINT_STEP: String(1024 ** 3) },
      {
        restartFootprintBytes: 2.5 * 1024 ** 3
      }
    )
    const stopped: string[] = []
    h.worker.onStopped((r) => stopped.push(r))
    h.worker.setIndexing(true)
    await h.worker.embedDocuments(['a', 'b']) // 2 GiB
    expect(h.spawned).toHaveLength(1)
    await h.worker.embedDocuments(['c', 'd']) // 3 GiB → Neustart danach
    // Vorgezogen: der neue Prozess startet sofort, nicht erst beim nächsten Batch
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2), { timeout: 3_000 })
    await vi.waitFor(() => expect(h.worker.getState().phase).toBe('ready'), { timeout: 3_000 })
    expect(stopped).toEqual(['memory'])
    await h.worker.embedDocuments(['e', 'f'])
    expect(h.spawned).toHaveLength(2)
    expect(h.worker.footprint.peak).toBeGreaterThan(2.5 * 1024 ** 3)
  })

  it('marks an unexpected SIGKILL as tool-blocked after the recheck, only during the pause', async () => {
    const h = create({}, { checkToolBlocked: async () => 'blocked' })
    const stopped: string[] = []
    h.worker.onStopped((r) => stopped.push(r))
    await h.worker.ensureStarted('warmup')
    process.kill(h.worker.pid!, 'SIGKILL')
    await h.spawned[0].waitForExit()
    await new Promise((r) => setTimeout(r, 50))
    expect(stopped).toEqual(['crash'])
    expect(h.worker.getState()).toEqual({ phase: 'stopped', reason: 'tool-blocked' })
    await expect(h.worker.embedQuery('x')).rejects.toMatchObject({ reason: 'tool-blocked' })
    expect(h.spawned).toHaveLength(1)
    // Nach der Pause meldet die Suche den Fehler nicht mehr und startet neu
    h.clock.now += 60_000
    expect(h.worker.getState().reason).toBeNull()
    await h.worker.embedQuery('x')
    expect(h.spawned).toHaveLength(2)
  })

  it('kill -9 (crash/OOM): after the pause the next query by meaning works again', async () => {
    const h = create()
    await h.worker.embedQuery('vorher')
    process.kill(h.worker.pid!, 'SIGKILL')
    await h.spawned[0].waitForExit()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.worker.getState().reason).toBe('error')
    expect(h.worker.getMessage()).toMatch(/startet gleich von selbst neu/)
    h.clock.now += 31_000
    expect(h.worker.getState().reason).toBeNull()
    expect(await h.worker.embedQuery('nachher')).toHaveLength(768)
    expect(h.spawned).toHaveLength(2)
  })

  it('a block Therascript repaired itself allows an immediate retry', async () => {
    const h = create({}, { checkToolBlocked: async () => 'repaired' })
    await h.worker.ensureStarted('warmup')
    process.kill(h.worker.pid!, 'SIGKILL')
    await h.spawned[0].waitForExit()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.worker.getState().reason).toBeNull()
    expect(await h.worker.embedQuery('x')).toHaveLength(768)
    expect(h.spawned).toHaveLength(2)
  })

  it('a request that falls into an intended stop window restarts instead of failing', async () => {
    const h = create({ FAKE_IGNORE_EOF: '1' })
    await h.worker.embedQuery('a')
    const stopping = h.worker.stop('idle')
    const answer = await h.worker.embedQuery('b')
    await stopping
    expect(answer).toHaveLength(768)
    expect(h.spawned).toHaveLength(2)
  })

  it('stops the start loop after 3 failed starts; a user search may retry, a new model resets', async () => {
    const h = create({ FAKE_EXIT_BEFORE_READY: '2' })
    for (let i = 0; i < 3; i++) {
      await expect(h.worker.embedDocuments(['x'])).rejects.toMatchObject({ kind: 'start' })
      h.clock.now += 31_000
    }
    expect(h.worker.getState().reason).toBe('error')
    expect(h.worker.getMessage()).toMatch(/mehrmals nicht starten/)
    // Die Aufbereitung startet nicht mehr …
    await expect(h.worker.embedDocuments(['x'])).rejects.toMatchObject({ kind: 'blocked' })
    expect(h.spawned).toHaveLength(3)
    // … eine USER-Suche schon (getUserReason ohne die Sperre)
    expect(h.worker.getUserReason()).toBeNull()
    await expect(h.worker.embedQuery('x')).rejects.toMatchObject({ kind: 'start' })
    expect(h.spawned).toHaveLength(4)
    h.clock.now += 31_000
    h.worker.resetStartFailures()
    expect(h.worker.getState().reason).toBeNull()
  })

  it('reports a crash during a request as error and rejects the request', async () => {
    const h = create()
    await h.worker.ensureStarted('warmup')
    const pending = h.worker.embedQuery('x')
    process.kill(h.worker.pid!, 'SIGTERM')
    const result = await pending.then(
      () => 'ok',
      (e) => e
    )
    // Je nach Zeitpunkt beantwortet der Dienst die Anfrage noch vor dem Ende
    if (result !== 'ok') expect(result).toBeInstanceOf(SearchWorkerUnavailableError)
    await h.spawned[0].waitForExit()
    await new Promise((r) => setTimeout(r, 50))
    expect(h.worker.getState()).toEqual({ phase: 'stopped', reason: 'error' })
  })

  it('reports a failed start (model not loadable) as error', async () => {
    const h = create({ FAKE_EXIT_BEFORE_READY: '2' })
    const err = await h.worker.ensureStarted('warmup').catch((e) => e)
    expect(err).toBeInstanceOf(SearchWorkerUnavailableError)
    expect(err.reason).toBe('error')
    expect(err.message).toContain('Exit-Code 2')
    expect(h.worker.getState().reason).toBe('error')
  })

  it('stops a service that does not answer in time; after the pause queries work again', async () => {
    const h = create({ FAKE_QUERY_DELAY_MS: '1000' }, { queryTimeoutMs: 100 })
    await h.worker.ensureStarted('warmup')
    const pid = h.worker.pid
    await expect(h.worker.embedQuery('x')).rejects.toMatchObject({
      reason: 'error',
      kind: 'request'
    })
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 })
    expect(h.worker.getState().reason).toBe('error')
    h.clock.now += 31_000
    expect(h.worker.getState().reason).toBeNull()
    // Der neue Prozess antwortet langsam, aber in der Frist eines längeren Timeouts
    expect(h.spawned).toHaveLength(1)
    await h.worker.ensureStarted('query')
    expect(h.spawned).toHaveLength(2)
  })

  it('emits state changes only when phase or reason change', async () => {
    const h = create()
    h.worker.refreshState()
    h.worker.refreshState()
    expect(h.states).toEqual([{ phase: 'stopped', reason: null }])
    h.processing.active = true
    h.worker.refreshState()
    expect(h.states.at(-1)).toEqual({ phase: 'stopped', reason: 'processing' })
  })
})
