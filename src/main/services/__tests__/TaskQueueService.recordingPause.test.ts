import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import type { TaskExecutor } from '../task-executors'
import { applyTestSchema } from '../../db/__tests__/test-utils'

// Mock sendToRenderer since BrowserWindow is not available in tests
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('gemma-3-4b'),
  getModelById: vi.fn().mockReturnValue({
    id: 'stub',
    label: 'Stub',
    sha256: '0'.repeat(64),
    sizeBytes: 0
  })
}))

vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: () => ({}) })
}))

const flush = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('TaskQueueService — Aufnahme-Pause', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionRepo: SessionRepository
  let sessionId: string

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)

    queue = new TaskQueueService(db)
    sessionRepo = new SessionRepository(db)

    const session = sessionRepo.create({
      title: 'Test Session',
      type: 'audio',
      status: 'queued'
    })
    sessionId = session.id
  })

  afterEach(async () => {
    queue.stop()
    await flush(50)
    db.close()
  })

  function registerCountingExecutor(): { calls: () => number } {
    let count = 0
    const executor: TaskExecutor = {
      async execute() {
        count++
      }
    }
    for (const type of [
      'diarization',
      'transcription',
      'alignment',
      'anonymization',
      'summarization'
    ] as const) {
      queue.registerExecutor(type, executor)
    }
    return { calls: () => count }
  }

  it('startet während der Pause keine Tasks — Session bleibt queued', async () => {
    const counter = registerCountingExecutor()

    queue.setRecordingPause(true)
    queue.enqueuePipeline(sessionId, 'audio')
    await flush()

    expect(counter.calls()).toBe(0)
    expect(queue.isProcessing()).toBe(false)

    const tasks = queue.getSessionTasks(sessionId)
    expect(tasks.every((t) => t.status === 'pending')).toBe(true)
    expect(sessionRepo.findById(sessionId)?.status).toBe('queued')
  })

  it('resume startet die wartenden Tasks', async () => {
    const counter = registerCountingExecutor()

    queue.setRecordingPause(true)
    queue.enqueuePipeline(sessionId, 'audio')
    await flush()
    expect(counter.calls()).toBe(0)

    queue.setRecordingPause(false)
    await flush(300)

    expect(counter.calls()).toBeGreaterThan(0)
    const session = sessionRepo.findById(sessionId)
    expect(session?.status).not.toBe('queued')
  })

  it('lässt einen bereits laufenden Task auslaufen, startet aber keinen weiteren', async () => {
    let resolveRunning: () => void = () => {}
    let started = 0
    const executor: TaskExecutor = {
      execute() {
        started++
        return new Promise<void>((resolve) => {
          resolveRunning = resolve
        })
      }
    }
    queue.registerExecutor('diarization', executor)
    queue.registerExecutor('transcription', executor)

    // Nur 2 Steps planen: plannedSteps via enqueue, restliche Executor stubben
    queue.enqueuePipeline(sessionId, 'audio')
    await flush()
    expect(started).toBe(1)

    // Pause setzen, während diarization noch läuft — dann Task beenden
    queue.setRecordingPause(true)
    resolveRunning()
    await flush(200)

    // Der laufende Task wurde abgeschlossen, der nächste NICHT gestartet
    const tasks = queue.getSessionTasks(sessionId)
    expect(tasks.find((t) => t.type === 'diarization')?.status).toBe('completed')
    expect(started).toBe(1)
    expect(queue.isProcessing()).toBe(false)

    // Resume → nächster Step startet
    queue.setRecordingPause(false)
    await flush(200)
    expect(started).toBe(2)

    // Hängenden Executor auflösen, damit kein Promise über das Testende leakt
    resolveRunning()
    await flush(50)
  })

  it('resume ohne vorherige Pause ist ein No-op', async () => {
    expect(() => queue.setRecordingPause(false)).not.toThrow()
  })

  it('recoverOrphanedSessions errort pausiert wartende Sessions NICHT', async () => {
    queue.setRecordingPause(true)
    queue.enqueuePipeline(sessionId, 'audio')
    await flush()

    // Pending-Tasks existieren → Session ist kein Orphan
    const recovered = queue.recoverOrphanedSessions()

    expect(recovered).toBe(0)
    expect(sessionRepo.findById(sessionId)?.status).toBe('queued')
  })
})
