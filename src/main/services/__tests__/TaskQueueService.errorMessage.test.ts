import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { sendToRenderer } from '../../utils/ipc-helpers'
import type { Task } from '../../../shared/types'

vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('gemma-4-e2b-summarization'),
  getModelById: vi
    .fn()
    .mockReturnValue({ id: 'stub', label: 'Stub', sha256: '0'.repeat(64), sizeBytes: 0 })
}))
vi.mock('../SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))

/** Sichtprüfung: Fehlermeldungen auf Sitzungskarten ohne absolute Pfade. */
describe('TaskQueueService — sichtbare Fehlermeldung', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionRepo: SessionRepository
  let taskRepo: TaskRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    queue = new TaskQueueService(db)
    sessionRepo = new SessionRepository(db)
    taskRepo = new TaskRepository(db)
    vi.mocked(sendToRenderer).mockClear()
  })

  it('zeigt die Meldung ohne Pfad (Karte und Ereignis), der Pfad bleibt nur im Log', () => {
    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    sessionRepo.update(session.id, { status: 'processing' })
    const task = taskRepo.create({ sessionId: session.id, type: 'transcription' }) as Task
    const fail = (queue as unknown as { handleTaskFailure(t: Task, m: string): void })
      .handleTaskFailure
    fail.call(
      queue,
      task,
      'whisper-cli binary nicht gefunden: /Users/anna/app/whisper-cli. Bitte prüfen Sie die Installation.'
    )
    const stored = sessionRepo.findById(session.id)
    expect(stored?.status).toBe('error')
    expect(stored?.errorMessage).toBe(
      'whisper-cli binary nicht gefunden. Bitte prüfen Sie die Installation.'
    )
    expect(sendToRenderer).toHaveBeenCalledWith(
      'task:error',
      expect.objectContaining({ error: stored?.errorMessage })
    )
  })
})
