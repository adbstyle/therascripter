import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../../services/SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  },
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

describe('session IPC handlers (integration via SessionService)', () => {
  let db: Database.Database
  let service: SessionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('session:list', () => {
    it('returns empty array when no sessions', () => {
      expect(service.getAllSessions()).toEqual([])
    })

    it('returns all sessions sorted by created_at DESC', () => {
      service.createSession('First', 'audio')
      service.createSession('Second', 'pdf')

      const sessions = service.getAllSessions()
      expect(sessions).toHaveLength(2)
      expect(sessions[0].title).toBe('Second')
      expect(sessions[1].title).toBe('First')
    })
  })

  describe('session:delete', () => {
    it('deletes an existing session', () => {
      const session = service.createSession('Delete Me', 'audio')
      const result = service.deleteSession(session.id)

      expect(result).toBe(true)
      expect(service.getSession(session.id)).toBeNull()
    })

    it('returns false for non-existent session', () => {
      expect(service.deleteSession('non-existent')).toBe(false)
    })
  })

  describe('session:rename', () => {
    it('renames an existing session', () => {
      const session = service.createSession('Old Title', 'audio')
      const renamed = service.renameSession(session.id, 'New Title')

      expect(renamed?.title).toBe('New Title')
    })

    it('returns null for non-existent session', () => {
      expect(service.renameSession('non-existent', 'Title')).toBeNull()
    })
  })
})
