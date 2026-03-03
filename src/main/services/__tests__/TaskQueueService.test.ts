import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'

// Mock sendToRenderer since BrowserWindow is not available in tests
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

function applySchema(db: Database.Database): void {
  const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations')
  db.exec(readFileSync(join(migrationsDir, '001-initial-schema.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '002-add-diarization-path.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '003-add-review-at.sql'), 'utf-8'))
}

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
    applySchema(db)

    queue = new TaskQueueService(db)
    sessionRepo = new SessionRepository(db)
    taskRepo = new TaskRepository(db)

    const session = sessionRepo.create({
      title: 'Test Session',
      type: 'audio',
      status: 'transcribing'
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

      expect(tasks).toHaveLength(4)
      expect(tasks[0].type).toBe('transcription')
      expect(tasks[1].type).toBe('diarization')
      expect(tasks[2].type).toBe('alignment')
      expect(tasks[3].type).toBe('anonymization')

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

      const tasks = queue.enqueuePipeline(pdfSession.id, 'pdf')

      expect(tasks).toHaveLength(3)
      expect(tasks[0].type).toBe('extraction')
      expect(tasks[1].type).toBe('ocr')
      expect(tasks[2].type).toBe('anonymization')
    })
  })

  describe('getSessionTasks', () => {
    it('returns tasks for a session', () => {
      queue.enqueuePipeline(sessionId, 'audio')
      const tasks = queue.getSessionTasks(sessionId)

      expect(tasks).toHaveLength(4)
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

      queue.enqueuePipeline(sessionId, 'audio')

      // Wait for all tasks to process
      await new Promise((resolve) => setTimeout(resolve, 200))

      expect(executionOrder).toEqual(['transcription', 'diarization', 'alignment', 'anonymization'])
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

      queue.registerExecutor('transcription', failingExecutor)

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 100))

      const session = sessionRepo.findById(sessionId)
      expect(session?.status).toBe('error')
      expect(session?.errorMessage).toBe('ML model failed')

      const tasks = queue.getSessionTasks(sessionId)
      const failedTask = tasks.find((t) => t.type === 'transcription')
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

      queue.enqueuePipeline(sessionId, 'audio')

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should have progress + completed events
      const calls = (sendToRenderer as ReturnType<typeof vi.fn>).mock.calls
      const progressCalls = calls.filter((c) => c[0] === 'task:progress')
      const completedCalls = calls.filter((c) => c[0] === 'task:completed')

      expect(progressCalls.length).toBeGreaterThan(0)
      expect(completedCalls).toHaveLength(4)
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

      queue.enqueuePipeline(sessionId, 'audio')

      // Stop after a short delay (should process at most 1-2 tasks)
      await new Promise((resolve) => setTimeout(resolve, 20))
      queue.stop()

      await new Promise((resolve) => setTimeout(resolve, 200))

      // Should not have processed all 4 tasks
      expect(executionOrder.length).toBeLessThan(4)
    })
  })
})
