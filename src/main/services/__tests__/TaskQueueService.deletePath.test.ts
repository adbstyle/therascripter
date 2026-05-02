import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

// Issue #84 / Story C — computePlannedSteps reads getActiveModelId which
// reaches into electron-store; mock it so this test doesn't have to init
// the real settings layer.
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue(null)
}))

/**
 * Issue #80 DR-6: deletePath verification.
 * Four contracts:
 *   (a) AbortController-Propagation — running task receives abort signal
 *   (b) pending-Tasks-Cleanup — pending tasks for the session are cancelled
 *   (c) Artefakt-Cleanup — partial pipeline files removed (delegated to
 *       SessionService.cleanupSessionFiles, covered by SessionService tests)
 *   (d) No-op-Toleranz im Executor — repository.update no-ops on missing rows
 *       (locked by the existing Repository.update contract: returns null when
 *       findById returns null)
 *
 * This file covers (a) and (b) end-to-end via TaskQueueService directly.
 */
describe('TaskQueueService.abortRunningForSession — DR-6 verification', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionRepo: SessionRepository
  let taskRepo: TaskRepository

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    queue = new TaskQueueService(db)
    sessionRepo = new SessionRepository(db)
    taskRepo = new TaskRepository(db)
  })

  afterEach(async () => {
    queue.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    db.close()
  })

  it('aborts the running task signal when called for the running session', async () => {
    let receivedSignal: AbortSignal | undefined
    const blockingExecutor: TaskExecutor = {
      async execute(_task, _onProgress, signal) {
        receivedSignal = signal
        // Block until aborted
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
    }
    queue.registerExecutor('diarization', blockingExecutor)

    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    queue.enqueuePipeline(session.id, 'audio')

    // Wait for the executor to start
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(receivedSignal?.aborted).toBe(false)

    queue.abortRunningForSession(session.id)
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('cancels all pending tasks for the session', async () => {
    const slowExecutor: TaskExecutor = {
      async execute(_task, _onProgress, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
    }
    queue.registerExecutor('diarization', slowExecutor)

    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    queue.enqueuePipeline(session.id, 'audio')

    // Issue #80: enqueuePipeline filters via computePlannedSteps. Without a
    // summarization model mocked-as-installed, audio plannedSteps = 4 steps
    // (no summarization). After 30ms: 1 running + 3 pending.
    await new Promise((resolve) => setTimeout(resolve, 30))
    let tasks = taskRepo.findBySession(session.id)
    expect(tasks.filter((t) => t.status === 'pending').length).toBe(3)
    expect(tasks.filter((t) => t.status === 'running').length).toBe(1)

    queue.abortRunningForSession(session.id)

    tasks = taskRepo.findBySession(session.id)
    expect(tasks.filter((t) => t.status === 'pending').length).toBe(0)
    expect(tasks.filter((t) => t.status === 'cancelled').length).toBe(3)
  })

  it('is a no-op when no task is running for the given session', () => {
    const otherSession = sessionRepo.create({ title: 'O', type: 'audio', status: 'queued' })

    expect(() => queue.abortRunningForSession(otherSession.id)).not.toThrow()
  })

  it('idempotent — calling twice does not double-cancel or throw', async () => {
    const slowExecutor: TaskExecutor = {
      async execute(_task, _onProgress, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }
    }
    queue.registerExecutor('diarization', slowExecutor)

    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    queue.enqueuePipeline(session.id, 'audio')
    await new Promise((resolve) => setTimeout(resolve, 30))

    queue.abortRunningForSession(session.id)
    expect(() => queue.abortRunningForSession(session.id)).not.toThrow()
  })
})
