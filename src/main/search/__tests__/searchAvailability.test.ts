import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/therascript-test', getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: vi.fn() }
}))
const sent: unknown[] = []
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: (channel: string, data: unknown) => {
    if (channel === 'search:availabilityChanged') sent.push(data)
  }
}))

import {
  onSearchModelStateChange,
  resetSentAvailabilityForTests,
  sendSearchAvailability
} from '../../services/search-model-provisioner-deps'
import {
  createBeforeTaskHook,
  initSearchRuntime,
  resetSearchRuntimeForTests
} from '../searchRuntime'
import type { LineProcess, LineProcessExit } from '../../utils/line-process'
import { createSearchTestDb } from './helpers'
import { TEST_MODEL } from './semanticHelpers'

// Verfügbarkeit der Suche (Review PR #226): ein Event nur bei geänderter
// Nutzlast, Provisioner «bereit» → Vektorphase, Hook über die echte Fabrik.

const VEC = Buffer.from(new Float32Array(768).fill(0.036).buffer).toString('base64')

class StubProcess {
  exitInfo: LineProcessExit | null = null
  private waiters: Array<(e: LineProcessExit) => void> = []
  pid = 4242
  weightsLine = null
  start(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ready: true, dim: 768 })
  }
  request(msg: { texts?: string[] }): Promise<Record<string, unknown>> {
    return new Promise((r) =>
      setTimeout(
        () =>
          r({ vectors: (msg.texts ?? []).map(() => VEC), vector: VEC, phys_footprint_bytes: 1 }),
        1
      )
    )
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

describe('search availability', () => {
  beforeEach(() => {
    sent.length = 0
    resetSentAvailabilityForTests()
  })
  afterEach(() => resetSearchRuntimeForTests())

  function runtime(spawned: StubProcess[] = []) {
    return initSearchRuntime(createSearchTestDb(), {
      isProcessingActive: () => false,
      onStateChange: () => sendSearchAvailability(),
      workerOverrides: {
        resolveModel: () => TEST_MODEL,
        resolveCommand: () => ({ bin: '/bin/true', args: [] }),
        createProcess: () => {
          const p = new StubProcess()
          spawned.push(p)
          return p as unknown as LineProcess
        }
      }
    })
  }

  it('sends search:availabilityChanged only when the payload changes (50 batches)', async () => {
    const rt = runtime()
    rt.worker.setIndexing(true)
    for (let i = 0; i < 50; i++) await rt.worker.embedDocuments(['a', 'b'])
    // stopped→starting (loading) und starting→ready; busy↔ready ist derselbe Stand
    expect(sent.map((a) => (a as { semantic: string }).semantic)).toEqual(['loading', 'ready'])
    rt.worker.setIndexing(false)
  })

  it('a ready model resets stopped starts, starts the vector phase and sends the event', () => {
    const calls: string[] = []
    onSearchModelStateChange(
      { status: 'ready' },
      {
        worker: { resetStartFailures: () => calls.push('reset'), refreshState: () => undefined },
        index: { maybeStartVectorPhase: () => calls.push('vectors') },
        send: () => calls.push('send')
      }
    )
    expect(calls).toEqual(['reset', 'vectors', 'send'])
    calls.length = 0
    onSearchModelStateChange(
      { status: 'downloading', progress: 3 },
      {
        worker: { resetStartFailures: () => calls.push('reset'), refreshState: () => undefined },
        index: { maybeStartVectorPhase: () => calls.push('vectors') },
        send: () => calls.push('send')
      }
    )
    expect(calls).toEqual(['send'])
  })

  it('the before-task hook from the real factory stops the process before resolving', async () => {
    const spawned: StubProcess[] = []
    const rt = runtime(spawned)
    await rt.worker.ensureStarted('warmup')
    let aborted = false
    const hook = createBeforeTaskHook(rt, {
      abortVectorPhase: async () => {
        aborted = true
      }
    })
    await hook()
    expect(spawned[0].exitInfo?.stopRequested).toBe(true)
    expect(rt.worker.getState().phase).toBe('stopped')
    expect(aborted).toBe(true)
  })
})
