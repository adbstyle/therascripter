import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SessionRepository } from '../repositories/SessionRepository'
import type { EntityMap } from '../../../shared/types'

function applySchema(db: Database.Database): void {
  const migrationsDir = join(__dirname, '..', 'migrations')
  db.exec(readFileSync(join(migrationsDir, '001-initial-schema.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '002-add-diarization-path.sql'), 'utf-8'))
  db.exec(readFileSync(join(migrationsDir, '003-add-review-at.sql'), 'utf-8'))
  db.exec(
    readFileSync(
      join(migrationsDir, '005-add-aligned-transcript-and-extracted-paths.sql'),
      'utf-8'
    )
  )
}

describe('SessionRepository', () => {
  let db: Database.Database
  let repo: SessionRepository

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchema(db)
    repo = new SessionRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('create', () => {
    it('creates an audio session with default status', () => {
      const session = repo.create({ title: 'Sitzung 14.02.2026 09:00', type: 'audio' })

      expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(session.title).toBe('Sitzung 14.02.2026 09:00')
      expect(session.type).toBe('audio')
      expect(session.status).toBe('recording')
      expect(session.audioPath).toBeNull()
      expect(session.transcriptPath).toBeNull()
      expect(session.anonymizedPath).toBeNull()
      expect(session.pdfPath).toBeNull()
      expect(session.entityMap).toBeNull()
      expect(session.errorMessage).toBeNull()
      expect(session.createdAt).toBeTruthy()
      expect(session.updatedAt).toBeTruthy()
    })

    it('creates a pdf session with extracting status', () => {
      const session = repo.create({
        title: 'Arztbericht',
        type: 'pdf',
        pdfPath: '/path/to/report.pdf'
      })

      expect(session.type).toBe('pdf')
      expect(session.status).toBe('extracting')
      expect(session.pdfPath).toBe('/path/to/report.pdf')
    })

    it('allows overriding the default status', () => {
      const session = repo.create({
        title: 'Test',
        type: 'audio',
        status: 'review'
      })

      expect(session.status).toBe('review')
    })

    it('stores audio path when provided', () => {
      const session = repo.create({
        title: 'Test',
        type: 'audio',
        audioPath: '/audio/test.wav'
      })

      expect(session.audioPath).toBe('/audio/test.wav')
    })
  })

  describe('findById', () => {
    it('returns the session when found', () => {
      const created = repo.create({ title: 'Find Me', type: 'audio' })
      const found = repo.findById(created.id)

      expect(found).toEqual(created)
    })

    it('returns null for non-existent id', () => {
      expect(repo.findById('non-existent')).toBeNull()
    })

    it('handles corrupted entity_map JSON gracefully', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      db.prepare('UPDATE sessions SET entity_map = ? WHERE id = ?').run('{invalid json', session.id)

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const retrieved = repo.findById(session.id)

      expect(retrieved?.entityMap).toBeNull()
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Corrupted entity_map in session ${session.id}`)
      )
      consoleSpy.mockRestore()
    })
  })

  describe('findAll', () => {
    it('returns empty array when no sessions exist', () => {
      expect(repo.findAll()).toEqual([])
    })

    it('returns sessions ordered by created_at descending', () => {
      const s1 = repo.create({ title: 'First', type: 'audio' })
      const s2 = repo.create({ title: 'Second', type: 'pdf' })

      const all = repo.findAll()

      expect(all).toHaveLength(2)
      // Second created last, so appears first (DESC order)
      expect(all[0].id).toBe(s2.id)
      expect(all[1].id).toBe(s1.id)
    })
  })

  describe('update', () => {
    it('updates the title', () => {
      const session = repo.create({ title: 'Old Title', type: 'audio' })
      const updated = repo.update(session.id, { title: 'New Title' })

      expect(updated?.title).toBe('New Title')
    })

    it('updates the status', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      const updated = repo.update(session.id, { status: 'transcribing' })

      expect(updated?.status).toBe('transcribing')
    })

    it('updates updated_at timestamp', async () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      await new Promise((r) => setTimeout(r, 5))
      const updated = repo.update(session.id, { title: 'Changed' })

      expect(updated?.updatedAt).not.toBe(session.updatedAt)
    })

    it('serializes and deserializes entity_map as JSON', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })

      const entityMap: EntityMap = {
        'person-1': {
          original: 'Dr. Müller',
          placeholder: '[PERSON 1]',
          type: 'PERSON',
          source: 'ner'
        },
        'ort-1': {
          original: 'Zürich',
          placeholder: '[ORT 1]',
          type: 'ORT',
          source: 'blocklist'
        }
      }

      const updated = repo.update(session.id, { entityMap })

      expect(updated?.entityMap).toEqual(entityMap)
      expect(updated?.entityMap?.['person-1']?.original).toBe('Dr. Müller')
      expect(updated?.entityMap?.['ort-1']?.source).toBe('blocklist')
    })

    it('clears entity_map when set to null', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      repo.update(session.id, {
        entityMap: {
          'p-1': { original: 'X', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
        }
      })
      const cleared = repo.update(session.id, { entityMap: null })

      expect(cleared?.entityMap).toBeNull()
    })

    it('returns null for non-existent session', () => {
      expect(repo.update('non-existent', { title: 'X' })).toBeNull()
    })

    it('returns session unchanged when no fields provided', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      const updated = repo.update(session.id, {})

      expect(updated?.title).toBe('Test')
    })

    it('updates multiple fields at once', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      const updated = repo.update(session.id, {
        status: 'review',
        transcriptPath: '/transcripts/test.json',
        anonymizedPath: '/anonymized/test.json'
      })

      expect(updated?.status).toBe('review')
      expect(updated?.transcriptPath).toBe('/transcripts/test.json')
      expect(updated?.anonymizedPath).toBe('/anonymized/test.json')
    })

    it('sets error message', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })
      const updated = repo.update(session.id, {
        status: 'error',
        errorMessage: 'Audiodatei ist beschädigt'
      })

      expect(updated?.status).toBe('error')
      expect(updated?.errorMessage).toBe('Audiodatei ist beschädigt')
    })
  })

  describe('delete', () => {
    it('deletes an existing session', () => {
      const session = repo.create({ title: 'Delete Me', type: 'audio' })

      expect(repo.delete(session.id)).toBe(true)
      expect(repo.findById(session.id)).toBeNull()
    })

    it('returns false for non-existent session', () => {
      expect(repo.delete('non-existent')).toBe(false)
    })

    it('cascades deletion to task_queue entries', () => {
      const session = repo.create({ title: 'Test', type: 'audio' })

      db.prepare(
        `INSERT INTO task_queue (id, session_id, type, status)
         VALUES (?, ?, 'transcription', 'pending')`
      ).run('task-1', session.id)

      repo.delete(session.id)

      const tasks = db.prepare('SELECT * FROM task_queue WHERE session_id = ?').all(session.id)
      expect(tasks).toHaveLength(0)
    })
  })

  describe('findReadyForSourceFileDeletion', () => {
    it('finds review sessions with source file and review_at older than 24h', () => {
      const oldReviewAt = new Date()
      oldReviewAt.setHours(oldReviewAt.getHours() - 25)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'ready',
        'Ready',
        'audio',
        'review',
        '/audio/ready.wav',
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString()
      )

      const sessions = repo.findReadyForSourceFileDeletion()

      expect(sessions).toHaveLength(1)
      expect(sessions[0].id).toBe('ready')
    })

    it('skips review sessions where 24h have not passed', () => {
      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'not-ready',
        'Not Ready',
        'audio',
        'review',
        '/audio/not-ready.wav',
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )

      expect(repo.findReadyForSourceFileDeletion()).toHaveLength(0)
    })

    it('skips review sessions where source file is already null', () => {
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

      expect(repo.findReadyForSourceFileDeletion()).toHaveLength(0)
    })

    it('skips sessions with review_at = null', () => {
      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'no-review-at',
        'No ReviewAt',
        'audio',
        'review',
        '/audio/no-review-at.wav',
        null,
        new Date().toISOString(),
        new Date().toISOString()
      )

      expect(repo.findReadyForSourceFileDeletion()).toHaveLength(0)
    })

    it('skips non-review sessions', () => {
      const oldReviewAt = new Date()
      oldReviewAt.setHours(oldReviewAt.getHours() - 25)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, audio_path, review_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'error-session',
        'Error Session',
        'audio',
        'error',
        '/audio/error.wav',
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString(),
        oldReviewAt.toISOString()
      )

      expect(repo.findReadyForSourceFileDeletion()).toHaveLength(0)
    })
  })

  describe('findOlderThan', () => {
    it('finds sessions older than the specified number of days', () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 31)

      db.prepare(
        `INSERT INTO sessions (id, title, type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('old-session', 'Old', 'audio', 'review', oldDate.toISOString(), oldDate.toISOString())

      repo.create({ title: 'New', type: 'audio' })

      const old = repo.findOlderThan(30)

      expect(old).toHaveLength(1)
      expect(old[0].id).toBe('old-session')
    })

    it('returns empty array when no old sessions exist', () => {
      repo.create({ title: 'Recent', type: 'audio' })

      expect(repo.findOlderThan(30)).toEqual([])
    })
  })
})
