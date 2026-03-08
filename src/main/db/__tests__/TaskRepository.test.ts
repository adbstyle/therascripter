import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { TaskRepository } from '../repositories/TaskRepository'
import { SessionRepository } from '../repositories/SessionRepository'
import { applyTestSchema } from './test-utils'

describe('TaskRepository', () => {
  let db: Database.Database
  let taskRepo: TaskRepository
  let sessionRepo: SessionRepository
  let sessionId: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    taskRepo = new TaskRepository(db)
    sessionRepo = new SessionRepository(db)

    // Create a session for task foreign keys
    const session = sessionRepo.create({ title: 'Test Session', type: 'audio' })
    sessionId = session.id
  })

  afterEach(() => {
    db.close()
  })

  describe('create', () => {
    it('creates a task with pending status and zero progress', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })

      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(task.sessionId).toBe(sessionId)
      expect(task.type).toBe('transcription')
      expect(task.status).toBe('pending')
      expect(task.progress).toBe(0)
      expect(task.error).toBeNull()
      expect(task.createdAt).toBeTruthy()
      expect(task.startedAt).toBeNull()
      expect(task.completedAt).toBeNull()
    })

    it('creates tasks with different types', () => {
      const types = [
        'transcription',
        'diarization',
        'alignment',
        'extraction',
        'ocr',
        'anonymization'
      ] as const

      for (const type of types) {
        const task = taskRepo.create({ sessionId, type })
        expect(task.type).toBe(type)
      }
    })
  })

  describe('findById', () => {
    it('returns the task when found', () => {
      const created = taskRepo.create({ sessionId, type: 'transcription' })
      const found = taskRepo.findById(created.id)

      expect(found).toEqual(created)
    })

    it('returns null for non-existent id', () => {
      expect(taskRepo.findById('non-existent')).toBeNull()
    })
  })

  describe('findBySession', () => {
    it('returns tasks ordered by created_at ASC', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      const t2 = taskRepo.create({ sessionId, type: 'diarization' })
      const t3 = taskRepo.create({ sessionId, type: 'anonymization' })

      const tasks = taskRepo.findBySession(sessionId)

      expect(tasks).toHaveLength(3)
      expect(tasks[0].id).toBe(t1.id)
      expect(tasks[1].id).toBe(t2.id)
      expect(tasks[2].id).toBe(t3.id)
    })

    it('returns empty array for session with no tasks', () => {
      expect(taskRepo.findBySession('non-existent')).toEqual([])
    })

    it('does not return tasks from other sessions', () => {
      taskRepo.create({ sessionId, type: 'transcription' })

      const otherSession = sessionRepo.create({ title: 'Other', type: 'audio' })
      taskRepo.create({ sessionId: otherSession.id, type: 'diarization' })

      const tasks = taskRepo.findBySession(sessionId)
      expect(tasks).toHaveLength(1)
      expect(tasks[0].type).toBe('transcription')
    })
  })

  describe('findPending', () => {
    it('returns the oldest pending task', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      taskRepo.create({ sessionId, type: 'diarization' })

      const pending = taskRepo.findPending()

      expect(pending?.id).toBe(t1.id)
    })

    it('returns null when no pending tasks exist', () => {
      expect(taskRepo.findPending()).toBeNull()
    })

    it('skips completed tasks', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      const t2 = taskRepo.create({ sessionId, type: 'diarization' })

      taskRepo.update(t1.id, { status: 'completed' })

      const pending = taskRepo.findPending()
      expect(pending?.id).toBe(t2.id)
    })
  })

  describe('findRunning', () => {
    it('returns tasks with running status', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      taskRepo.create({ sessionId, type: 'diarization' })

      taskRepo.update(t1.id, { status: 'running' })

      const running = taskRepo.findRunning()
      expect(running).toHaveLength(1)
      expect(running[0].id).toBe(t1.id)
    })

    it('returns empty array when no tasks are running', () => {
      taskRepo.create({ sessionId, type: 'transcription' })
      expect(taskRepo.findRunning()).toEqual([])
    })
  })

  describe('update', () => {
    it('updates status', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })
      const updated = taskRepo.update(task.id, { status: 'running' })

      expect(updated?.status).toBe('running')
    })

    it('updates progress', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })
      const updated = taskRepo.update(task.id, { progress: 0.5 })

      expect(updated?.progress).toBe(0.5)
    })

    it('updates error message', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })
      const updated = taskRepo.update(task.id, {
        status: 'failed',
        error: 'Something went wrong'
      })

      expect(updated?.status).toBe('failed')
      expect(updated?.error).toBe('Something went wrong')
    })

    it('updates timestamps', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })
      const now = new Date().toISOString()
      const updated = taskRepo.update(task.id, {
        status: 'running',
        startedAt: now
      })

      expect(updated?.startedAt).toBe(now)
    })

    it('returns null for non-existent task', () => {
      expect(taskRepo.update('non-existent', { status: 'running' })).toBeNull()
    })

    it('returns unchanged task when no fields provided', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })
      const updated = taskRepo.update(task.id, {})

      expect(updated?.status).toBe('pending')
    })
  })

  describe('delete', () => {
    it('deletes an existing task', () => {
      const task = taskRepo.create({ sessionId, type: 'transcription' })

      expect(taskRepo.delete(task.id)).toBe(true)
      expect(taskRepo.findById(task.id)).toBeNull()
    })

    it('returns false for non-existent task', () => {
      expect(taskRepo.delete('non-existent')).toBe(false)
    })
  })

  describe('resetRunningToPending', () => {
    it('resets running tasks to pending', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      const t2 = taskRepo.create({ sessionId, type: 'diarization' })

      taskRepo.update(t1.id, { status: 'running', startedAt: new Date().toISOString() })
      taskRepo.update(t2.id, { status: 'running', startedAt: new Date().toISOString() })

      const count = taskRepo.resetRunningToPending()

      expect(count).toBe(2)

      const r1 = taskRepo.findById(t1.id)
      expect(r1?.status).toBe('pending')
      expect(r1?.startedAt).toBeNull()
      expect(r1?.progress).toBe(0)

      const r2 = taskRepo.findById(t2.id)
      expect(r2?.status).toBe('pending')
    })

    it('does not affect completed or failed tasks', () => {
      const t1 = taskRepo.create({ sessionId, type: 'transcription' })
      const t2 = taskRepo.create({ sessionId, type: 'diarization' })

      taskRepo.update(t1.id, { status: 'completed' })
      taskRepo.update(t2.id, { status: 'failed', error: 'err' })

      const count = taskRepo.resetRunningToPending()
      expect(count).toBe(0)

      expect(taskRepo.findById(t1.id)?.status).toBe('completed')
      expect(taskRepo.findById(t2.id)?.status).toBe('failed')
    })

    it('returns 0 when no running tasks exist', () => {
      taskRepo.create({ sessionId, type: 'transcription' })
      expect(taskRepo.resetRunningToPending()).toBe(0)
    })
  })

  describe('cascade delete', () => {
    it('deletes tasks when parent session is deleted', () => {
      taskRepo.create({ sessionId, type: 'transcription' })
      taskRepo.create({ sessionId, type: 'diarization' })

      sessionRepo.delete(sessionId)

      expect(taskRepo.findBySession(sessionId)).toEqual([])
    })
  })
})
