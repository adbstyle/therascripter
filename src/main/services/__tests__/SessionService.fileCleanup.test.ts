import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

const mockRemoveFile = vi.fn()
vi.mock('../../utils/file-ops', () => ({
  removeFile: (...args: unknown[]) => mockRemoveFile(...args)
}))

describe('SessionService file cleanup', () => {
  let db: Database.Database
  let service: SessionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
    mockRemoveFile.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  it('deletes associated files when deleting a session with paths', () => {
    const session = service.createSession('Test', 'audio')
    service.updateSession(session.id, {
      audioPath: '/mock/home/.therascript/audio/test.wav',
      transcriptPath: '/mock/home/.therascript/transcripts/test.json'
    })

    const result = service.deleteSession(session.id)

    expect(result).toBe(true)
    expect(service.getSession(session.id)).toBeNull()
    const calledPaths = mockRemoveFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calledPaths).toContain('/mock/home/.therascript/audio/test.wav')
    expect(calledPaths).toContain('/mock/home/.therascript/transcripts/test.json')
  })

  it('always attempts to delete convention-based paths (recovery for audio)', () => {
    const session = service.createSession('Test', 'audio')

    service.deleteSession(session.id)

    const calledPaths = mockRemoveFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calledPaths.some((p: string) => p.includes('recovery'))).toBe(true)
    // extracted fallback only applies to PDF sessions
    expect(calledPaths.some((p: string) => p.includes('extracted'))).toBe(false)
  })

  it('deletes convention-based extracted path for PDF sessions without extractedPath in DB', () => {
    const session = service.createSession('Test', 'pdf')

    service.deleteSession(session.id)

    const calledPaths = mockRemoveFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calledPaths.some((p: string) => p.includes('extracted'))).toBe(true)
  })

  it('returns false for non-existent session', () => {
    expect(service.deleteSession('non-existent')).toBe(false)
    expect(mockRemoveFile).not.toHaveBeenCalled()
  })

  it('deletes only the source file during cleanupSourceFiles', () => {
    const oldReviewAt = new Date()
    oldReviewAt.setHours(oldReviewAt.getHours() - 25)

    db.prepare(
      `INSERT INTO sessions (id, title, type, status, audio_path, transcript_path, review_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'source-cleanup',
      'Source Cleanup',
      'audio',
      'review',
      '/mock/home/.therascript/audio/source-cleanup.wav',
      '/mock/home/.therascript/transcripts/source-cleanup.json',
      oldReviewAt.toISOString(),
      oldReviewAt.toISOString(),
      oldReviewAt.toISOString()
    )

    const cleaned = service.cleanupSourceFiles()

    expect(cleaned).toBe(1)
    const calledPaths = mockRemoveFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calledPaths).toContain('/mock/home/.therascript/audio/source-cleanup.wav')
    // Transcript must NOT be deleted
    expect(calledPaths).not.toContain('/mock/home/.therascript/transcripts/source-cleanup.json')
    // audio_path nulled in DB
    expect(service.getSession('source-cleanup')?.audioPath).toBeNull()
  })

  it('cleans up files during cleanupOldSessions', () => {
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 31)

    db.prepare(
      `INSERT INTO sessions (id, title, type, status, audio_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'old-1',
      'Old Session',
      'audio',
      'review',
      '/mock/home/.therascript/audio/old-1.wav',
      oldDate.toISOString(),
      oldDate.toISOString()
    )

    const deleted = service.cleanupOldSessions()

    expect(deleted).toBe(1)
    const calledPaths = mockRemoveFile.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(calledPaths).toContain('/mock/home/.therascript/audio/old-1.wav')
  })
})
