import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionRepository } from '../../db/repositories/SessionRepository'
import { applyTestSchema } from '../../db/__tests__/test-utils'

// Review PR #231: Pfade in Fehlermeldungen erreichen den Renderer nicht —
// weder aus Meldungen von vor dem Update (Lesen) noch über task:getSessionTasks.

const handlers = vi.hoisted(() => new Map<string, (event: unknown, args?: unknown) => unknown>())
const tasks = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, fn)
  }
}))
vi.mock('../../services/TaskQueueService', () => ({
  getTaskQueue: () => ({ getSessionTasks: () => tasks.list })
}))

import { registerTaskHandlers } from '../task-handlers'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

describe('Fehlermeldungen ohne Pfade zum Renderer', () => {
  beforeEach(() => {
    handlers.clear()
    registerTaskHandlers()
  })

  it('task:getSessionTasks liefert Task.error ohne absolute Pfade', () => {
    tasks.list = [
      {
        id: 't1',
        sessionId: SESSION_ID,
        type: 'transcription',
        status: 'failed',
        error: 'Whisper-Modell nicht gefunden: /Users/anna/.therascript/models/asr/x.bin.'
      },
      { id: 't2', sessionId: SESSION_ID, type: 'diarization', status: 'completed', error: null }
    ]
    const result = handlers.get('task:getSessionTasks')!({}, { sessionId: SESSION_ID }) as Array<{
      error: string | null
    }>
    expect(result[0].error).toBe('Whisper-Modell nicht gefunden.')
    expect(result[1].error).toBeNull()
  })

  it('eine Sitzungsmeldung von vor dem Update wird beim Lesen gefiltert', () => {
    const db = new Database(':memory:')
    applyTestSchema(db)
    const repo = new SessionRepository(db)
    const session = repo.create({ title: 'T', type: 'audio', status: 'queued' })
    db.prepare('UPDATE sessions SET status = ?, error_message = ? WHERE id = ?').run(
      'error',
      'Audiodatei nicht gefunden: /Users/anna/.therascript/audio/a.wav',
      session.id
    )
    expect(repo.findById(session.id)?.errorMessage).toBe('Audiodatei nicht gefunden')
    expect(repo.findAll().find((s) => s.id === session.id)?.errorMessage).toBe(
      'Audiodatei nicht gefunden'
    )
    db.close()
  })
})
