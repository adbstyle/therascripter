import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import { TaskRepository } from '../../db/repositories/TaskRepository'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

const mockRemoveFile = vi.fn()
const mockRemoveFileReporting = vi.fn((_path: string) => true)
vi.mock('../../utils/file-ops', () => ({
  removeFile: (...args: unknown[]) => mockRemoveFile(...args),
  removeFileReporting: (path: string) => mockRemoveFileReporting(path)
}))

function deletedPaths(): string[] {
  return mockRemoveFileReporting.mock.calls.map((c) => c[0])
}

describe('SessionService file cleanup', () => {
  let db: Database.Database
  let service: SessionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applyTestSchema(db)
    service = new SessionService(db)
    mockRemoveFile.mockClear()
    mockRemoveFileReporting.mockReset()
    mockRemoveFileReporting.mockImplementation(() => true)
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
    const calledPaths = deletedPaths()
    expect(calledPaths).toContain('/mock/home/.therascript/audio/test.wav')
    expect(calledPaths).toContain('/mock/home/.therascript/transcripts/test.json')
  })

  it('always attempts to delete every convention-based path of the session', () => {
    const session = service.createSession('Test', 'audio')

    service.deleteSession(session.id)

    const id = session.id
    expect(deletedPaths()).toEqual(
      expect.arrayContaining([
        `/mock/home/.therascript/audio/${id}.wav`,
        `/mock/home/.therascript/transcripts/${id}.json`,
        `/mock/home/.therascript/transcripts/${id}-aligned.json`,
        `/mock/home/.therascript/diarization/${id}.json`,
        `/mock/home/.therascript/anonymized/${id}.json`,
        `/mock/home/.therascript/pdf/${id}.pdf`,
        `/mock/home/.therascript/extracted/${id}.json`,
        `/mock/home/.therascript/recovery/${id}.pcm`
      ])
    )
  })

  it('deletes the stored PDF path even if it differs from the convention', () => {
    const session = service.createSession('Test', 'pdf', '/elsewhere/report.pdf')

    service.deleteSession(session.id)

    expect(deletedPaths()).toContain('/elsewhere/report.pdf')
  })

  it('returns false for non-existent session', () => {
    expect(service.deleteSession('non-existent')).toBe(false)
    expect(mockRemoveFileReporting).not.toHaveBeenCalled()
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

  describe('restart-proof deletion (Issue #202, Postcondition 2)', () => {
    function rowExists(id: string): boolean {
      return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined
    }

    it('keeps the mark and scrubs the content when a file cannot be removed', () => {
      const session = service.createSession('Hans Muster', 'audio')
      service.updateSession(session.id, {
        audioPath: '/mock/home/.therascript/audio/locked.wav',
        summary: 'Vertrauliche Zusammenfassung'
      })
      mockRemoveFileReporting.mockImplementation((p) => !p.endsWith('locked.wav'))

      expect(service.deleteSession(session.id)).toBe(true)

      // The user no longer sees the session …
      expect(service.getSession(session.id)).toBeNull()
      expect(service.getAllSessions()).toEqual([])
      // … the row stays marked for the next start, without its text content
      expect(rowExists(session.id)).toBe(true)
      const row = db
        .prepare('SELECT title, summary, deleting_at, audio_path FROM sessions WHERE id = ?')
        .get(session.id) as Record<string, string | null>
      expect(row.deleting_at).not.toBeNull()
      expect(row.title).toBe('')
      expect(row.summary).toBeNull()
      expect(row.audio_path).toBe('/mock/home/.therascript/audio/locked.wav')
    })

    it('drops document date and dossier assignments right away, too (#205 PC 5/6)', () => {
      const pdf = service.createSession('Bericht', 'pdf')
      service.updateSession(pdf.id, { pdfPath: '/mock/home/.therascript/pdf/locked.pdf' })
      service.setDocumentDate(pdf.id, '2024-01-02')
      db.prepare(
        `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
           created_at, updated_at) VALUES ('d1', 'A', 'B', 'a', 'b', 'x', 'x')`
      ).run()
      db.prepare(
        "INSERT INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, 'd1', 'x')"
      ).run(pdf.id)
      mockRemoveFileReporting.mockImplementation((p) => !p.endsWith('locked.pdf'))

      expect(service.deleteSession(pdf.id)).toBe(true)

      expect(rowExists(pdf.id)).toBe(true)
      const row = db.prepare('SELECT document_date FROM sessions WHERE id = ?').get(pdf.id) as {
        document_date: string | null
      }
      expect(row.document_date).toBeNull()
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM session_dossiers WHERE session_id = ?').get(pdf.id)
      ).toEqual({ n: 0 })
    })

    it('finishPendingDeletions completes a deletion once the files can be removed', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { audioPath: '/mock/home/.therascript/audio/locked.wav' })
      mockRemoveFileReporting.mockImplementation((p) => !p.endsWith('locked.wav'))
      service.deleteSession(session.id)

      // Still locked at the next start: stays marked
      expect(service.finishPendingDeletions()).toBe(0)
      expect(rowExists(session.id)).toBe(true)

      // Removable at the start after that: done
      mockRemoveFileReporting.mockImplementation(() => true)
      mockRemoveFileReporting.mockClear()
      expect(service.finishPendingDeletions()).toBe(1)
      expect(rowExists(session.id)).toBe(false)
      expect(deletedPaths()).toContain('/mock/home/.therascript/audio/locked.wav')
    })

    it('finishPendingDeletions completes a deletion interrupted after the mark (crash)', () => {
      const session = service.createSession('Test', 'pdf', '/mock/home/.therascript/pdf/x.pdf')
      new TaskRepository(db).create({ sessionId: session.id, type: 'extraction' })
      // Simulates a crash right after phase 1
      db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        session.id
      )
      expect(service.getAllSessions()).toEqual([])

      expect(service.finishPendingDeletions()).toBe(1)

      expect(rowExists(session.id)).toBe(false)
      expect(deletedPaths()).toContain('/mock/home/.therascript/pdf/x.pdf')
      const tasks = db.prepare('SELECT * FROM task_queue WHERE session_id = ?').all(session.id)
      expect(tasks).toEqual([])
    })

    it('a repeated delete of a marked session finishes it instead of failing', () => {
      const session = service.createSession('Test', 'audio')
      db.prepare('UPDATE sessions SET deleting_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        session.id
      )

      expect(service.deleteSession(session.id)).toBe(true)
      expect(rowExists(session.id)).toBe(false)
    })

    it('finishPendingDeletions leaves unmarked sessions untouched', () => {
      const session = service.createSession('Bleibt', 'audio')

      expect(service.finishPendingDeletions()).toBe(0)
      expect(service.getSession(session.id)?.title).toBe('Bleibt')
      expect(mockRemoveFileReporting).not.toHaveBeenCalled()
    })
  })
})
