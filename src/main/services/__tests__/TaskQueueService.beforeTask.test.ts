// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'path'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { SearchWorker } from '../../search/SearchWorker'

// Epic #192: Hook vor jedem Task. Der Task beginnt erst, wenn der Suchprozess
// wirklich beendet ist — nie gleichzeitig mit NER/whisper/llama (#209 AK 17).

vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('gemma-4-e2b-summarization'),
  getModelById: vi.fn().mockReturnValue({ id: 'stub', label: 'Stub', sha256: '0'.repeat(64) })
}))
vi.mock('../SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))

const FAKE = join(__dirname, '..', '..', 'utils', '__tests__', 'fixtures', 'fake-line-service.mjs')
const flush = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const TYPES = [
  'diarization',
  'transcription',
  'alignment',
  'anonymization',
  'summarization'
] as const

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('TaskQueueService — Hook vor jedem Task', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    queue = new TaskQueueService(db)
    sessionId = new SessionRepository(db).create({ title: 'T', type: 'audio', status: 'queued' }).id
  })

  afterEach(async () => {
    queue.stop()
    await flush(50)
    db.close()
  })

  it('starts the task only after the search process has really exited', async () => {
    const worker = new SearchWorker({
      resolveModel: () => ({
        dir: '/x',
        modelId: 'fake',
        dim: 768,
        queryPrompt: '',
        documentPrompt: '',
        maxTokens: 1024,
        padMultiple: 128
      }),
      resolveCommand: () => ({ bin: process.execPath, args: [FAKE] }),
      isProcessingActive: () => queue.hasActiveWork(),
      // Der Dienst ignoriert EOF: das Beenden braucht SIGTERM (~300 ms)
      extraEnv: { FAKE_IGNORE_EOF: '1' },
      eofGraceMs: 300,
      killGraceMs: 300
    })
    await worker.ensureStarted('warmup')
    const pid = worker.pid
    expect(alive(pid)).toBe(true)

    queue.setBeforeTaskHook(() => worker.stop('processing'))
    const seen: Array<{ alive: boolean; phase: string }> = []
    const executor: TaskExecutor = {
      async execute() {
        seen.push({ alive: alive(pid), phase: worker.getState().phase })
      }
    }
    for (const type of TYPES) queue.registerExecutor(type, executor)
    queue.enqueuePipeline(sessionId, 'audio')
    queue.start()
    await flush(1500)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => !s.alive && s.phase === 'stopped')).toBe(true)
    // Während der Verarbeitung startet der Suchprozess nicht
    expect(worker.getState().reason === null || worker.getState().reason === 'processing').toBe(
      true
    )
  })

  it('keeps the task pending until the hook has finished', async () => {
    let releaseHook: () => void = () => {}
    const hookCalls: string[] = []
    queue.setBeforeTaskHook(
      () =>
        new Promise<void>((resolve) => {
          const running = new TaskRepository(db)
            .findBySession(sessionId)
            .filter((t) => t.status === 'running')
          hookCalls.push(`running=${running.length}`)
          releaseHook = resolve
        })
    )
    let executed = 0
    const executor: TaskExecutor = {
      async execute() {
        executed++
      }
    }
    for (const type of TYPES) queue.registerExecutor(type, executor)
    queue.enqueuePipeline(sessionId, 'audio')
    queue.start()
    await flush(100)
    expect(hookCalls).toEqual(['running=0'])
    expect(executed).toBe(0)
    expect(queue.hasActiveWork()).toBe(true)
    releaseHook()
    await flush(100)
    expect(executed).toBe(1)
  })

  it('a failing hook does not stop the task', async () => {
    queue.setBeforeTaskHook(() => Promise.reject(new Error('kaputt')))
    let executed = 0
    for (const type of TYPES) {
      queue.registerExecutor(type, {
        async execute() {
          executed++
        }
      })
    }
    queue.enqueuePipeline(sessionId, 'audio')
    queue.start()
    await flush(300)
    expect(executed).toBeGreaterThan(0)
  })

  it('does not start the task when a recording begins during the hook', async () => {
    let releaseHook: () => void = () => {}
    queue.setBeforeTaskHook(() => new Promise<void>((resolve) => (releaseHook = resolve)))
    let executed = 0
    for (const type of TYPES) {
      queue.registerExecutor(type, {
        async execute() {
          executed++
        }
      })
    }
    queue.enqueuePipeline(sessionId, 'audio')
    queue.start()
    await flush(50)
    queue.setRecordingPause(true)
    releaseHook()
    await flush(100)
    expect(executed).toBe(0)
    expect(queue.isProcessing()).toBe(false)
    // Aufnahme: wartende Tasks sperren die Suche nach Bedeutung nicht
    expect(queue.hasActiveWork()).toBe(false)
    queue.setBeforeTaskHook(null)
    queue.setRecordingPause(false)
    await flush(300)
    expect(executed).toBeGreaterThan(0)
  })
})
