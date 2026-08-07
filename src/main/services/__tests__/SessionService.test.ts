import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SessionService } from '../SessionService'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

describe('SessionService', () => {
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

  describe('createSession', () => {
    it('creates an audio session with recording status', () => {
      const session = service.createSession('Sitzung 14.02.2026 14:30', 'audio')

      expect(session.title).toBe('Sitzung 14.02.2026 14:30')
      expect(session.type).toBe('audio')
      expect(session.status).toBe('recording')
    })

    it('creates a pdf session with queued status', () => {
      const session = service.createSession('Arztbericht', 'pdf', '/path/report.pdf')

      expect(session.type).toBe('pdf')
      expect(session.status).toBe('queued')
      expect(session.pdfPath).toBe('/path/report.pdf')
    })
  })

  describe('getSession / getAllSessions', () => {
    it('retrieves a session by id', () => {
      const created = service.createSession('Test', 'audio')
      const found = service.getSession(created.id)

      expect(found).toEqual(created)
    })

    it('returns null for non-existent session', () => {
      expect(service.getSession('non-existent')).toBeNull()
    })

    it('returns all sessions', () => {
      service.createSession('Session 1', 'audio')
      service.createSession('Session 2', 'pdf')

      expect(service.getAllSessions()).toHaveLength(2)
    })
  })

  describe('updateSession — status transitions', () => {
    // Issue #80 DR-5: lifecycle is recording → queued → processing → review.
    // Pipeline-step granularity is now in tasks[]; SessionStatus only tracks phase.
    it('allows recording → queued', () => {
      const session = service.createSession('Test', 'audio')
      const updated = service.updateSession(session.id, { status: 'queued' })

      expect(updated?.status).toBe('queued')
    })

    it('allows queued → processing', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'queued' })
      const updated = service.updateSession(session.id, { status: 'processing' })

      expect(updated?.status).toBe('processing')
    })

    it('allows processing → review', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'queued' })
      service.updateSession(session.id, { status: 'processing' })
      const updated = service.updateSession(session.id, { status: 'review' })

      expect(updated?.status).toBe('review')
    })

    it('allows pdf queued → processing', () => {
      const session = service.createSession('PDF', 'pdf')
      // PDF sessions default to 'queued' (post-Issue #80)
      expect(session.status).toBe('queued')
      const updated = service.updateSession(session.id, { status: 'processing' })

      expect(updated?.status).toBe('processing')
    })

    it('allows recording → error', () => {
      const session = service.createSession('Test', 'audio')
      const updated = service.updateSession(session.id, { status: 'error' })

      expect(updated?.status).toBe('error')
    })

    it('allows error → queued (retry)', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'error' })
      const updated = service.updateSession(session.id, { status: 'queued' })

      expect(updated?.status).toBe('queued')
    })

    it('allows error → error (second failure must not lose the new errorMessage)', () => {
      // handleTaskFailure setzt status:'error' + errorMessage in EINEM Update.
      // War die Session schon in error (z. B. zweiter fehlgeschlagener Task
      // derselben Pipeline), warf die Transition-Validierung — die neue
      // Fehlermeldung ging verloren, DB und UI divergierten.
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'error', errorMessage: 'Erster Fehler' })
      const updated = service.updateSession(session.id, {
        status: 'error',
        errorMessage: 'Zweiter Fehler'
      })

      expect(updated?.status).toBe('error')
      expect(updated?.errorMessage).toBe('Zweiter Fehler')
    })

    it('rejects invalid transition recording → review', () => {
      const session = service.createSession('Test', 'audio')

      expect(() => {
        service.updateSession(session.id, { status: 'review' })
      }).toThrow('Invalid status transition: recording → review')
    })

    it('rejects invalid transition recording → processing (must go via queued)', () => {
      const session = service.createSession('Test', 'audio')

      expect(() => {
        service.updateSession(session.id, { status: 'processing' })
      }).toThrow('Invalid status transition')
    })

    it('throws for non-existent session on status update', () => {
      expect(() => {
        service.updateSession('non-existent', { status: 'review' })
      }).toThrow('Session non-existent not found')
    })

    it('allows idempotent self-transition processing → processing', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'queued' })
      service.updateSession(session.id, { status: 'processing' })

      // processing → processing is legitimate (multiple tasks within the same phase)
      const updated = service.updateSession(session.id, { status: 'processing' })
      expect(updated?.status).toBe('processing')
    })
  })

  describe('updateSession — non-status updates', () => {
    it('updates title without status validation', () => {
      const session = service.createSession('Old', 'audio')
      const updated = service.updateSession(session.id, { title: 'New' })

      expect(updated?.title).toBe('New')
    })
  })

  describe('renameSession', () => {
    it('renames a session', () => {
      const session = service.createSession('Old Title', 'audio')
      const renamed = service.renameSession(session.id, 'New Title')

      expect(renamed?.title).toBe('New Title')
    })
  })

  describe('deleteSession', () => {
    it('deletes a session', () => {
      const session = service.createSession('Delete Me', 'audio')

      expect(service.deleteSession(session.id)).toBe(true)
      expect(service.getSession(session.id)).toBeNull()
    })
  })

  describe('updateSession — reviewAt auto-set', () => {
    it('sets reviewAt on first transition to review', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'queued' })
      service.updateSession(session.id, { status: 'processing' })
      const updated = service.updateSession(session.id, { status: 'review' })

      expect(updated?.reviewAt).toBeTruthy()
      expect(new Date(updated!.reviewAt!).getTime()).toBeCloseTo(Date.now(), -3)
    })

    it('does not reset reviewAt on review → review (re-anonymization)', () => {
      const session = service.createSession('Test', 'audio')
      service.updateSession(session.id, { status: 'queued' })
      service.updateSession(session.id, { status: 'processing' })
      const firstReview = service.updateSession(session.id, { status: 'review' })
      const firstReviewAt = firstReview!.reviewAt

      const secondReview = service.updateSession(session.id, { status: 'review' })

      expect(secondReview?.reviewAt).toBe(firstReviewAt)
    })

    it('reviewAt is null for non-review sessions', () => {
      const session = service.createSession('Test', 'audio')
      const updated = service.updateSession(session.id, { status: 'queued' })

      expect(updated?.reviewAt).toBeNull()
    })
  })

  describe('cleanupOldSessions', () => {
    it('deletes sessions older than 30 days', () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 31)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('old-1', 'Old 1', 'audio', 'review', oldDate.toISOString(), oldDate.toISOString())

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('old-2', 'Old 2', 'pdf', 'review', oldDate.toISOString(), oldDate.toISOString())

      service.createSession('Recent', 'audio')

      const deleted = service.cleanupOldSessions()

      expect(deleted).toBe(2)
      expect(service.getAllSessions()).toHaveLength(1)
    })

    it('returns 0 when no old sessions exist', () => {
      service.createSession('Recent', 'audio')

      expect(service.cleanupOldSessions()).toBe(0)
    })
  })

  describe('cleanupSourceFiles', () => {
    it('returns 0 when no sessions are ready for source file deletion', () => {
      service.createSession('Recent', 'audio')

      expect(service.cleanupSourceFiles()).toBe(0)
    })

    it('returns 0 for review sessions where 24h have not passed', () => {
      const session = service.createSession('Test', 'audio')
      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'recent-review',
        'Recent Review',
        'audio',
        'review',
        '/audio/recent.wav',
        new Date().toISOString(),
        session.createdAt,
        session.updatedAt
      )

      expect(service.cleanupSourceFiles()).toBe(0)
    })

    it('cleans up audio source file after 24h', () => {
      const oldReviewAt = new Date()
      oldReviewAt.setHours(oldReviewAt.getHours() - 25)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ready-audio',
        'Ready Audio',
        'audio',
        'review',
        '/audio/ready.wav',
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString()
      )

      const cleaned = service.cleanupSourceFiles()

      expect(cleaned).toBe(1)
      expect(service.getSession('ready-audio')?.audioPath).toBeNull()
    })

    it('cleans up pdf source file after 24h', () => {
      const oldReviewAt = new Date()
      oldReviewAt.setHours(oldReviewAt.getHours() - 25)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, pdf_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ready-pdf',
        'Ready PDF',
        'pdf',
        'review',
        '/pdf/ready.pdf',
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString()
      )

      const cleaned = service.cleanupSourceFiles()

      expect(cleaned).toBe(1)
      expect(service.getSession('ready-pdf')?.pdfPath).toBeNull()
    })

    it('skips sessions where source file is already deleted (path is null)', () => {
      const oldReviewAt = new Date()
      oldReviewAt.setHours(oldReviewAt.getHours() - 25)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'already-cleaned',
        'Already Cleaned',
        'audio',
        'review',
        null,
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString()
      )

      expect(service.cleanupSourceFiles()).toBe(0)
    })
  })

  describe('path generation', () => {
    it('generates audio path', () => {
      const path = service.generateAudioPath('abc-123')

      expect(path).toBe('/mock/home/.therascript/audio/abc-123.wav')
    })

    it('generates transcript path', () => {
      const path = service.generateTranscriptPath('abc-123')

      expect(path).toBe('/mock/home/.therascript/transcripts/abc-123.json')
    })

    it('generates anonymized path', () => {
      const path = service.generateAnonymizedPath('abc-123')

      expect(path).toBe('/mock/home/.therascript/anonymized/abc-123.json')
    })
  })

  describe('summary methods', () => {
    it('saveGeneratedSummary persists title + text + modelId, getSummary round-trips', () => {
      const session = service.createSession('Initial Title', 'audio')

      service.saveGeneratedSummary(
        session.id,
        'Schlafstörungen und Arbeitsstress',
        'Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.',
        'gemma-summarization'
      )

      const summary = service.getSummary(session.id)
      expect(summary).not.toBeNull()
      expect(summary?.title).toBe('Schlafstörungen und Arbeitsstress')
      expect(summary?.text).toBe(
        'Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.'
      )
      expect(summary?.modelId).toBe('gemma-summarization')
      expect(summary?.summarizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('getSummary returns the record when only title is set (text empty)', () => {
      const session = service.createSession('Sitzung 14.02.2026', 'audio')

      const summary = service.getSummary(session.id)
      expect(summary).not.toBeNull()
      expect(summary?.title).toBe('Sitzung 14.02.2026')
      expect(summary?.text).toBe('')
      expect(summary?.modelId).toBeNull()
    })

    it('updateSummaryText clears summary_model_id (user edit overrides LLM provenance)', () => {
      const session = service.createSession('Original', 'audio')
      service.saveGeneratedSummary(session.id, 'LLM Title', 'LLM text.', 'gemma-summarization')

      service.updateSummaryText(session.id, 'User-edited summary.')

      const summary = service.getSummary(session.id)
      expect(summary?.text).toBe('User-edited summary.')
      expect(summary?.modelId).toBeNull()
    })

    it('updateTitle persists trimmed title; empty string is stored as empty', () => {
      const session = service.createSession('Old', 'audio')

      service.updateTitle(session.id, '  Neuer Titel  ')
      expect(service.getSummary(session.id)?.title).toBe('Neuer Titel')

      service.updateTitle(session.id, '')
      // Empty title still stored — view layer renders date fallback when empty.
      const after = service.getSession(session.id)
      expect(after?.title).toBe('')
    })

    it('getAnonymizedPlainText throws when session has no anonymized document', () => {
      const session = service.createSession('Test', 'audio')
      expect(() => service.getAnonymizedPlainText(session.id)).toThrow(/anonymisiertes Dokument/)
    })
  })
})
