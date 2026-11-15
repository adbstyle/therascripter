import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))
vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue(null),
  getModelById: vi.fn().mockReturnValue(undefined)
}))
vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: () => ({}) })
}))

import { TaskQueueService } from '../TaskQueueService'
import { SessionService } from '../SessionService'
import { TaskRepository } from '../../db/repositories/TaskRepository'
import type { TaskExecutor } from '../task-executors'
import { applyTestSchema } from '../../db/__tests__/test-utils'

// Issue #202: an executor that keeps going after the session was deleted must
// not leave files behind — the queue removes them after the run.
describe('TaskQueueService — files written after a deletion are removed', () => {
  let db: Database.Database
  let queue: TaskQueueService
  let sessions: SessionService

  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'deleted-session-cleanup-'))
    for (const dir of ['extracted', 'transcripts', 'pdf']) {
      mkdirSync(join(home.path, '.therascript', dir), { recursive: true })
    }
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    queue = new TaskQueueService(db)
    sessions = new SessionService(db)
  })

  afterEach(async () => {
    queue.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    db.close()
    rmSync(home.path, { recursive: true, force: true })
  })

  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('removes a file the executor writes after the session was deleted', async () => {
    let started = false
    let release: () => void = () => {}
    let writtenPath = ''
    const lateWriter: TaskExecutor = {
      async execute(task) {
        started = true
        // Ignores the abort signal, like a pdf.js await that settles late
        await new Promise<void>((resolve) => (release = resolve))
        writtenPath = join(home.path, '.therascript', 'extracted', `${task.sessionId}.json`)
        writeFileSync(writtenPath, '{"text":"Hans Muster"}')
      }
    }
    queue.registerExecutor('extraction', lateWriter)

    const session = sessions.createSession('PDF', 'pdf')
    queue.enqueuePipeline(session.id, 'pdf')
    await waitFor(() => started)
    expect(started).toBe(true)

    // What session:delete does (the singleton is not initialised in this test)
    sessions.deleteSession(session.id)
    queue.abortRunningForSession(session.id)

    release()
    await waitFor(() => writtenPath !== '' && !existsSync(writtenPath))

    expect(writtenPath).not.toBe('')
    expect(existsSync(writtenPath)).toBe(false)
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session.id)).toBeUndefined()
  })

  it('leaves the files of a session that still exists alone', async () => {
    let done = false
    let writtenPath = ''
    const writer: TaskExecutor = {
      async execute(task) {
        writtenPath = join(home.path, '.therascript', 'extracted', `${task.sessionId}.json`)
        writeFileSync(writtenPath, '{}')
        done = true
      }
    }
    queue.registerExecutor('extraction', writer)
    queue.registerExecutor('ocr', { async execute() {} })
    queue.registerExecutor('anonymization', { async execute() {} })

    const session = sessions.createSession('PDF', 'pdf')
    queue.enqueuePipeline(session.id, 'pdf')
    await waitFor(() => done && new TaskRepository(db).findPending() === null)

    expect(existsSync(writtenPath)).toBe(true)
  })
})
