import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { TaskQueueService } from '../TaskQueueService'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn(),
  // Issue #84 Story I — ProvenanceCapture (called from enqueuePipeline)
  // resolves the active id to a catalog entry. Stub a minimal shape so the
  // capture path doesn't NPE; provenance content is not asserted here.
  getModelById: vi.fn().mockReturnValue({
    id: 'stub',
    label: 'Stub',
    sha256: '0'.repeat(64),
    sizeBytes: 0
  })
}))

// ProvenanceCapture also reads installedModelVersions from electron-store;
// tests don't init settings, so stub the module entirely.
vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: () => ({}) })
}))

import { getActiveModelId } from '../ModelDownloadService'

/**
 * Issue #80 invariant: enqueuePipeline + retrySession must enqueue exactly
 * the tasks that computePlannedSteps freezes on the session. Otherwise the
 * renderer's task:started event computes stepIndex=0 for filtered-out tasks
 * (e.g. summarization without model installed, ocr on text-only PDF) and
 * the SessionCard renders "Schritt 0/N · …" briefly.
 */
describe('TaskQueueService — enqueue + plannedSteps invariant', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessionRepo: SessionRepository
  let taskRepo: TaskRepository

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no summarization model active. Issue #84 / Story C — getActiveModelId
    // does the disk-presence check internally and returns null on
    // missing-or-not-installed; tests opt into "model active" by returning a
    // non-null id from the mock.
    vi.mocked(getActiveModelId).mockReturnValue(null)
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

  describe('enqueuePipeline', () => {
    it('omits summarization when no LLM model is active (audio)', () => {
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      queue.enqueuePipeline(session.id, 'audio')

      const tasks = taskRepo.findBySession(session.id)
      const types = tasks.map((t) => t.type)
      expect(types).toEqual(['diarization', 'transcription', 'alignment', 'anonymization'])
      expect(types).not.toContain('summarization')

      const reloaded = sessionRepo.findById(session.id)
      expect(reloaded?.plannedSteps).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization'
      ])
    })

    it('includes summarization when an LLM model is active AND installed', () => {
      vi.mocked(getActiveModelId).mockReturnValue('gemma-3-4b')
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      queue.enqueuePipeline(session.id, 'audio')

      const tasks = taskRepo.findBySession(session.id)
      const types = tasks.map((t) => t.type)
      expect(types).toContain('summarization')
      expect(sessionRepo.findById(session.id)?.plannedSteps).toContain('summarization')
    })

    it('always includes ocr for PDF — executor self-skips when no scanned pages', () => {
      const session = sessionRepo.create({ title: 'T', type: 'pdf', status: 'queued' })
      sessionRepo.update(session.id, { pdfHasScannedPages: false })
      queue.enqueuePipeline(session.id, 'pdf')

      const tasks = taskRepo.findBySession(session.id)
      const types = tasks.map((t) => t.type)
      expect(types).toEqual(['extraction', 'ocr', 'anonymization'])

      const reloaded = sessionRepo.findById(session.id)
      expect(reloaded?.plannedSteps).toEqual(['extraction', 'ocr', 'anonymization'])
    })

    it('includes ocr regardless of pdfHasScannedPages flag', () => {
      const session = sessionRepo.create({ title: 'T', type: 'pdf', status: 'queued' })
      sessionRepo.update(session.id, { pdfHasScannedPages: true })
      queue.enqueuePipeline(session.id, 'pdf')

      const types = taskRepo.findBySession(session.id).map((t) => t.type)
      expect(types).toEqual(['extraction', 'ocr', 'anonymization'])
    })

    it('throws when sessionId does not resolve', () => {
      expect(() => queue.enqueuePipeline('nonexistent', 'audio')).toThrow(/not found/)
    })

    it('frozen plannedSteps matches the enqueued task list 1:1', () => {
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      queue.enqueuePipeline(session.id, 'audio')

      const tasks = taskRepo.findBySession(session.id).map((t) => t.type)
      const planned = sessionRepo.findById(session.id)?.plannedSteps ?? []
      expect(tasks).toEqual(planned)
    })
  })

  describe('retrySession', () => {
    it('honours frozen plannedSteps on retry — even legacy plans without ocr', () => {
      // Arrange: simulate a pre-fix session whose frozen plan omitted ocr.
      // Retry must replay exactly what was frozen, not the new always-include-ocr
      // default — that's the whole point of freezing plannedSteps.
      const session = sessionRepo.create({ title: 'T', type: 'pdf', status: 'queued' })
      sessionRepo.update(session.id, {
        pdfHasScannedPages: false,
        plannedSteps: ['extraction', 'anonymization'],
        status: 'error',
        errorMessage: 'Test failure'
      })
      // Pre-existing failed extraction task (would have been deleted on retry).
      taskRepo.create({ sessionId: session.id, type: 'extraction' })

      // Act
      queue.retrySession(session.id)

      // Assert: frozen plan is replayed verbatim.
      const types = taskRepo.findBySession(session.id).map((t) => t.type)
      expect(types).not.toContain('summarization')
      expect(types).toEqual(['extraction', 'anonymization'])
    })

    it('audio without summarization model: retry does not re-add summarization', () => {
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      sessionRepo.update(session.id, {
        plannedSteps: ['diarization', 'transcription', 'alignment', 'anonymization'],
        status: 'error',
        errorMessage: 'Test failure'
      })
      taskRepo.create({ sessionId: session.id, type: 'diarization' })

      queue.retrySession(session.id)

      const types = taskRepo.findBySession(session.id).map((t) => t.type)
      expect(types).not.toContain('summarization')
    })

    it('legacy session row without plannedSteps falls back to a fresh compute', () => {
      // Arrange: simulate pre-Phase-H session — no plannedSteps stored.
      const session = sessionRepo.create({ title: 'T', type: 'audio', status: 'queued' })
      sessionRepo.update(session.id, {
        plannedSteps: null,
        status: 'error',
        errorMessage: 'Legacy failure'
      })
      taskRepo.create({ sessionId: session.id, type: 'diarization' })

      // Act
      queue.retrySession(session.id)

      // Assert: plannedSteps gets frozen now (no model active → 4 audio steps)
      const reloaded = sessionRepo.findById(session.id)
      expect(reloaded?.plannedSteps).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization'
      ])
    })
  })
})
