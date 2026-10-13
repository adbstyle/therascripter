import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { toolBlockedMessage } from '../../../shared/tool-blocked'
import { getActiveModelId } from '../ModelDownloadService'

vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue('gemma-4-e2b-summarization'),
  getModelById: vi
    .fn()
    .mockReturnValue({ id: 'stub', label: 'Stub', sha256: '0'.repeat(64), sizeBytes: 0 })
}))
vi.mock('../SettingsService', () => ({ getSettings: () => ({ get: () => ({}) }) }))

describe('TaskQueueService — blockierte Werkzeuge (#168)', () => {
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
  })

  function failedSession(errorMessage: string, retryCount: number): string {
    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    sessionRepo.update(session.id, {
      plannedSteps: ['diarization', 'transcription', 'alignment', 'anonymization'],
      status: 'error',
      errorMessage,
      retryCount
    })
    taskRepo.create({ sessionId: session.id, type: 'diarization' })
    return session.id
  }

  it('eine Blockade zählt nicht zur Grenze der Wiederholungen (AK 6)', () => {
    const id = failedSession(toolBlockedMessage('python', false), 3)
    queue.retrySession(id)
    expect(sessionRepo.findById(id)?.retryCount).toBe(3)
  })

  it('andere Fehler zählen weiter', () => {
    const id = failedSession('NER Fehler (Exit Code 1): Traceback', 1)
    queue.retrySession(id)
    expect(sessionRepo.findById(id)?.retryCount).toBe(2)
  })

  describe('Zusammenfassung nachholen', () => {
    function reviewSession(): string {
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      sessionRepo.update(session.id, { status: 'processing' })
      sessionRepo.update(session.id, { status: 'review' })
      return session.id
    }

    it('nennt die Blockade als Grund, solange der letzte Versuch daran scheiterte', () => {
      const id = reviewSession()
      const task = taskRepo.create({ sessionId: id, type: 'summarization' })
      taskRepo.update(task.id, { status: 'failed', error: toolBlockedMessage('llama', false) })
      expect(queue.summaryMissingReason(id)).toBe('tool-blocked')
    })

    it('kein Hinweis, wenn sich ohne aktives Modell nichts nachholen lässt', () => {
      const id = reviewSession()
      const task = taskRepo.create({ sessionId: id, type: 'summarization' })
      taskRepo.update(task.id, { status: 'failed', error: toolBlockedMessage('llama', false) })
      vi.mocked(getActiveModelId).mockReturnValueOnce(null)
      expect(queue.summaryMissingReason(id)).toBeNull()
    })

    it('kein Grund bei anderen Fehlern oder ohne Versuch', () => {
      const id = reviewSession()
      expect(queue.summaryMissingReason(id)).toBeNull()
      const task = taskRepo.create({ sessionId: id, type: 'summarization' })
      taskRepo.update(task.id, { status: 'failed', error: 'llama-cli Timeout' })
      expect(queue.summaryMissingReason(id)).toBeNull()
    })

    it('legt genau einen neuen Versuch an', () => {
      const id = reviewSession()
      expect(queue.regenerateSummary(id)).toBe(true)
      expect(queue.regenerateSummary(id)).toBe(false)
      const pending = taskRepo
        .findBySession(id)
        .filter((t) => t.type === 'summarization' && t.status === 'pending')
      expect(pending).toHaveLength(1)
      expect(queue.summaryMissingReason(id)).toBeNull()
    })

    it('nur für Sitzungen im Review', () => {
      const id = failedSession('x', 0)
      expect(queue.regenerateSummary(id)).toBe(false)
    })
  })

  it('verarbeitet erst, wenn die Werkzeug-Prüfung durch ist', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)
    queue.registerExecutor('diarization', { execute })
    let release: () => void = () => undefined
    queue.holdUntil(new Promise<void>((resolve) => (release = resolve)))
    const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
    taskRepo.create({ sessionId: session.id, type: 'diarization' })
    queue.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(execute).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    queue.stop()
  })
})
