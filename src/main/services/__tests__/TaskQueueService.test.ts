import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'
import { applyTestSchema } from '../../db/__tests__/test-utils'

// Mock sendToRenderer since BrowserWindow is not available in tests
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

// Issue #80: enqueuePipeline now filters via computePlannedSteps. These tests
// pre-date the filter and assert against the full pipeline (5 audio steps,
// 4 PDF steps); mock ModelDownloadService so the summarization step survives
// the filter. PDF sessions also need pdfHasScannedPages=true to include ocr.
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('gemma-3-4b'),
  isModelInstalled: vi.fn().mockReturnValue(true)
}))

describe('TaskQueueService', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionRepo: SessionRepository
  let taskRepo: TaskRepository
  let sessionId: string

  beforeEach(() => {
    vi.clearAllMocks()
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)

    queue = new TaskQueueService(db)
    sessionRepo = new SessionRepository(db)
    taskRepo = new TaskRepository(db)

    const session = sessionRepo.create({
      title: 'Test Session',
      type: 'audio',
      status: 'processing'
    })
    sessionId = session.id
  })

  afterEach(async () => {
    queue.stop()
    // Allow pending setTimeout(processNext, 0) callbacks to drain before closing DB
    await new Promise((resolve) => setTimeout(resolve, 50))
    db.close()
  })

  describe('enqueuePipeline', () => {
    it('enqueues audio pipeline tasks in correct order', () => {
      const tasks = queue.enqueuePipeline(sessionId, 'audio')

      expect(tasks).toHaveLength(5)
      expect(tasks[0].type).toBe('diarization')
      expect(tasks[1].type).toBe('transcription')
      expect(tasks[2].type).toBe('alignment')
      expect(tasks[3].type).toBe('anonymization')
      expect(tasks[4].type).toBe('summarization')

      for (const task of tasks) {
        expect(task.sessionId).toBe(sessionId)
        expect(task.status).toBe('pending')
        expect(task.progress).toBe(0)
      }
    })

    it('enqueues PDF pipeline tasks in correct order', () => {
      const pdfSession = sessionRepo.create({
        title: 'PDF Test',
        type: 'pdf'
      })
      // Force OCR into plannedSteps; default pdfHasScannedPages is null/false.
      sessionRepo.update(pdfSession.id, { pdfHasScannedPages: true })

      const tasks = queue.enqueuePipeline(pdfSession.id, 'pdf')

      expect(tasks).toHaveLength(4)
      expect(tasks[0].type).toBe('extraction')
      expect(tasks[1].type).toBe('ocr')
      expect(tasks[2].type).toBe('anonymization')
      expect(tasks[3].type).toBe('summarization')
    })
  })

  describe('getSessionTasks', () => {
    it('returns tasks for a session', () => {
      queue.enqueuePipeline(sessionId, 'audio')
      const tasks = queue.getSessionTasks(sessionId)

      expect(tasks).toHaveLength(5)
    })

    it('returns empty array for session with no tasks', () => {
      expect(queue.getSessionTasks('non-existent')).toEqual([])
    })
  })

  describe('recoverStuckTasks', () => {
    it('resets running tasks to pending', () => {
      const tasks = queue.enqueuePipeline(sessionId, 'audio')
      taskRepo.update(tasks[0].id, {
        status: 'running',
        startedAt: new Date().toISOString()
      })

      const count = queue.recoverStuckTasks()

      expect(count).toBe(1)
      const recovered = taskRepo.findById(tasks[0].id)
      expect(recovered?.status).toBe('pending')
    })
  })

  describe('sequential processing', () => {
    it('processes tasks in FIFO order', async () => {
      const executionOrder: string[] = []

      const trackingExecutor: TaskExecutor = {
        async execute(task, onProgress) {
          executionOrder.push(task.type)
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', trackingExecutor)
      queue.registerExecutor('diarization', trackingExecutor)
      queue.registerExecutor('alignment', trackingExecutor)
      queue.registerExecutor('anonymization', trackingExecutor)
      queue.registerExecutor('summarization', trackingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      // Wait for all tasks to process
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(executionOrder).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization',
        'summarization'
      ])
    })

    it('marks tasks as completed after execution', async () => {
      const instantExecutor: TaskExecutor = {
        async execute(_task, onProgress) {
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', instantExecutor)
      queue.registerExecutor('diarization', instantExecutor)
      queue.registerExecutor('alignment', instantExecutor)
      queue.registerExecutor('anonymization', instantExecutor)
      queue.registerExecutor('summarization', instantExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 200))

      const tasks = queue.getSessionTasks(sessionId)
      for (const task of tasks) {
        expect(task.status).toBe('completed')
        expect(task.progress).toBe(1)
        expect(task.completedAt).toBeTruthy()
      }
    })

    it('sets session to review after all tasks complete', async () => {
      const instantExecutor: TaskExecutor = {
        async execute(_task, onProgress) {
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', instantExecutor)
      queue.registerExecutor('diarization', instantExecutor)
      queue.registerExecutor('alignment', instantExecutor)
      queue.registerExecutor('anonymization', instantExecutor)
      queue.registerExecutor('summarization', instantExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 200))

      const session = sessionRepo.findById(sessionId)
      expect(session?.status).toBe('review')
    })

    it('sets session to error on task failure', async () => {
      const failingExecutor: TaskExecutor = {
        async execute() {
          throw new Error('ML model failed')
        }
      }

      // Diarization is the first pipeline step (post-ADR-007)
      queue.registerExecutor('diarization', failingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 100))

      const session = sessionRepo.findById(sessionId)
      expect(session?.status).toBe('error')
      expect(session?.errorMessage).toBe('ML model failed')

      const tasks = queue.getSessionTasks(sessionId)
      const failedTask = tasks.find((t) => t.type === 'diarization')
      expect(failedTask?.status).toBe('failed')
      expect(failedTask?.error).toBe('ML model failed')
    })

    it('emits progress events during execution', async () => {
      const { sendToRenderer } = await import('../../utils/ipc-helpers')

      const progressExecutor: TaskExecutor = {
        async execute(_task, onProgress) {
          onProgress(0.5)
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', progressExecutor)
      queue.registerExecutor('diarization', progressExecutor)
      queue.registerExecutor('alignment', progressExecutor)
      queue.registerExecutor('anonymization', progressExecutor)
      queue.registerExecutor('summarization', progressExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should have progress + completed events
      const calls = (sendToRenderer as ReturnType<typeof vi.fn>).mock.calls
      const progressCalls = calls.filter((c) => c[0] === 'task:progress')
      const completedCalls = calls.filter((c) => c[0] === 'task:completed')

      expect(progressCalls.length).toBeGreaterThan(0)
      expect(completedCalls).toHaveLength(5)
    })
  })

  describe('task cancellation on failure', () => {
    it('cancels remaining pending tasks when a task fails', async () => {
      const failingExecutor: TaskExecutor = {
        async execute() {
          throw new Error('Diarization failed')
        }
      }

      // Diarization is the first pipeline step (post-ADR-007)
      queue.registerExecutor('diarization', failingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 100))

      const tasks = queue.getSessionTasks(sessionId)
      const failed = tasks.filter((t) => t.status === 'failed')
      const cancelled = tasks.filter((t) => t.status === 'cancelled')

      expect(failed).toHaveLength(1)
      expect(failed[0].type).toBe('diarization')
      expect(cancelled).toHaveLength(4) // transcription, alignment, anonymization, summarization
    })

    it('does not execute cancelled tasks', async () => {
      const executionOrder: string[] = []

      // Diarization is the first pipeline step (post-ADR-007); fail it to
      // verify subsequent steps are cancelled rather than executed.
      const failingDiarization: TaskExecutor = {
        async execute() {
          executionOrder.push('diarization')
          throw new Error('fail')
        }
      }

      const trackingExecutor: TaskExecutor = {
        async execute(task) {
          executionOrder.push(task.type)
        }
      }

      queue.registerExecutor('diarization', failingDiarization)
      queue.registerExecutor('transcription', trackingExecutor)
      queue.registerExecutor('alignment', trackingExecutor)
      queue.registerExecutor('anonymization', trackingExecutor)
      queue.registerExecutor('summarization', trackingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Only diarization should have executed — the rest were cancelled
      expect(executionOrder).toEqual(['diarization'])
    })
  })

  describe('multi-session processing', () => {
    it('processes second session after first completes', async () => {
      const session2 = sessionRepo.create({
        title: 'Session 2',
        type: 'audio',
        status: 'processing'
      })

      const executionOrder: string[] = []

      const trackingExecutor: TaskExecutor = {
        async execute(task, onProgress) {
          executionOrder.push(`${task.sessionId.slice(0, 8)}:${task.type}`)
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', trackingExecutor)
      queue.registerExecutor('diarization', trackingExecutor)
      queue.registerExecutor('alignment', trackingExecutor)
      queue.registerExecutor('anonymization', trackingExecutor)
      queue.registerExecutor('summarization', trackingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')
      queue.enqueuePipeline(session2.id, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 500))

      // Both sessions should reach review
      const s1 = sessionRepo.findById(sessionId)
      const s2 = sessionRepo.findById(session2.id)
      expect(s1?.status).toBe('review')
      expect(s2?.status).toBe('review')

      // All 10 tasks (5 per session × 2 sessions) should have executed
      expect(executionOrder).toHaveLength(10)
    })

    it('second session still processes when first fails', async () => {
      const session2 = sessionRepo.create({
        title: 'Session 2',
        type: 'audio',
        status: 'processing'
      })

      const failOnFirst: TaskExecutor = {
        async execute(task, onProgress) {
          if (task.sessionId === sessionId && task.type === 'transcription') {
            throw new Error('fail')
          }
          onProgress(1)
        }
      }

      queue.registerExecutor('transcription', failOnFirst)
      queue.registerExecutor('diarization', failOnFirst)
      queue.registerExecutor('alignment', failOnFirst)
      queue.registerExecutor('anonymization', failOnFirst)
      queue.registerExecutor('summarization', failOnFirst)

      queue.enqueuePipeline(sessionId, 'audio')
      queue.enqueuePipeline(session2.id, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 500))

      const s1 = sessionRepo.findById(sessionId)
      const s2 = sessionRepo.findById(session2.id)
      expect(s1?.status).toBe('error')
      expect(s2?.status).toBe('review')
    })
  })

  describe('stop', () => {
    it('stops processing after current task', async () => {
      const executionOrder: string[] = []

      const slowExecutor: TaskExecutor = {
        async execute(task, onProgress) {
          executionOrder.push(task.type)
          onProgress(1)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }

      queue.registerExecutor('transcription', slowExecutor)
      queue.registerExecutor('diarization', slowExecutor)
      queue.registerExecutor('alignment', slowExecutor)
      queue.registerExecutor('anonymization', slowExecutor)
      queue.registerExecutor('summarization', slowExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      // Stop after a short delay (should process at most 1-2 tasks)
      await new Promise((resolve) => setTimeout(resolve, 20))
      queue.stop()

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should not have processed all 5 tasks
      expect(executionOrder.length).toBeLessThan(5)
    })
  })
})
