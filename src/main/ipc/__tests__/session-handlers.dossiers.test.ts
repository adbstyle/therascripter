import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, args?: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, fn)
  },
  app: { getPath: () => '/mock/home' },
  BrowserWindow: { getAllWindows: () => [] }
}))
const database = vi.hoisted(() => ({ db: null as Database.Database | null }))
vi.mock('../../db/connection', () => ({
  getDatabase: () => database.db,
  getDataDir: () => '/mock/home/.therascript'
}))

import { registerSessionHandlers } from '../session-handlers'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import type { SessionListItem } from '../../../shared/types/Dossier'

/** #205 — `session:list` mit Plaketten und `session:setDocumentDate` über den echten Handler. */
describe('session IPC handlers (#205)', () => {
  let db: Database.Database

  function invoke(channel: string, args?: unknown): unknown {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({}, args)
  }

  function insertSession(id: string, type: 'audio' | 'pdf', createdAt: string): void {
    db.prepare(
      `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'review', ?, ?)`
    ).run(id, `Titel ${id}`, type, createdAt, createdAt)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0))
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    database.db = db
    handlers.clear()
    registerSessionHandlers()
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  it('session:list returns SessionListItem with the dossiers of each session', () => {
    insertSession('a', 'audio', '2026-11-10T09:00:00.000Z')
    insertSession('b', 'pdf', '2026-11-11T09:00:00.000Z')
    db.prepare(
      `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
         external_id, external_id_norm, birth_date, created_at, updated_at)
       VALUES ('d1', 'Lukas', 'Hofer', 'lukas', 'hofer', 'PD-1188', 'pd-1188', '1978-02-03', 'x', 'x')`
    ).run()
    db.prepare(
      "INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES ('a', 'd1', 'x')"
    ).run()

    const list = invoke('session:list') as SessionListItem[]
    expect(list.map((s) => [s.id, s.dossiers])).toEqual([
      ['b', []],
      [
        'a',
        [
          {
            id: 'd1',
            firstName: 'Lukas',
            lastName: 'Hofer',
            externalId: 'PD-1188',
            birthDate: '1978-02-03'
          }
        ]
      ]
    ])
  })

  it('session:setDocumentDate stores a valid date of a PDF', () => {
    insertSession('p', 'pdf', '2026-11-10T09:00:00.000Z')
    expect(
      invoke('session:setDocumentDate', { sessionId: 'p', documentDate: '2026-11-02' })
    ).toEqual({ ok: true })
    const list = invoke('session:list') as SessionListItem[]
    expect(list[0].documentDate).toBe('2026-11-02')
  })

  it('session:setDocumentDate answers not-pdf / not-found', () => {
    insertSession('a', 'audio', '2026-11-10T09:00:00.000Z')
    expect(
      invoke('session:setDocumentDate', { sessionId: 'a', documentDate: '2026-11-02' })
    ).toEqual({ ok: false, reason: 'not-pdf' })
    expect(
      invoke('session:setDocumentDate', { sessionId: 'missing', documentDate: '2026-11-02' })
    ).toEqual({ ok: false, reason: 'not-found' })
  })

  it('session:setDocumentDate rejects invalid payloads before the service', () => {
    insertSession('p', 'pdf', '2026-11-10T09:00:00.000Z')
    for (const documentDate of ['2026-11-15', '2026-02-30', '0026-11-02', null, '14.11.2026']) {
      expect(() => invoke('session:setDocumentDate', { sessionId: 'p', documentDate })).toThrow(
        /session:setDocumentDate/
      )
    }
    expect(() =>
      invoke('session:setDocumentDate', { sessionId: 'p', documentDate: '2026-11-02', x: 1 })
    ).toThrow()
    const row = db.prepare("SELECT document_date FROM sessions WHERE id = 'p'").get() as {
      document_date: string | null
    }
    expect(row.document_date).toBeNull()
  })
})
