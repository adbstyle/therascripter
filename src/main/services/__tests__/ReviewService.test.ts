import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ReviewService } from '../ReviewService'
import { SessionService } from '../SessionService'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'
import type { EntityMap } from '../../../shared/types'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

function applySchema(db: Database.Database): void {
  const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations')
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

const sampleDoc: TipTapDocument = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Der Patient ' },
        {
          type: 'placeholderChip',
          attrs: {
            entityId: 'e1',
            type: 'PERSON',
            number: 1,
            source: 'ner',
            original: 'Max Müller'
          }
        },
        { type: 'text', text: ' berichtet.' }
      ]
    }
  ]
}

const sampleEntityMap: EntityMap = {
  e1: {
    original: 'Max Müller',
    placeholder: '[PERSON 1]',
    type: 'PERSON',
    source: 'ner'
  }
}

describe('ReviewService', () => {
  let db: Database.Database
  let sessionService: SessionService
  let reviewService: ReviewService
  let tmpDir: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    applySchema(db)
    sessionService = new SessionService(db)
    reviewService = new ReviewService(db)

    // Create a temp directory for document files
    tmpDir = join(tmpdir(), `therascript-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    db.close()
  })

  function createReviewSession(): string {
    const session = sessionService.createSession('Test Session', 'audio')
    // Transition through pipeline: recording → transcribing → diarizing → anonymizing → review
    sessionService.updateSession(session.id, { status: 'transcribing' })
    sessionService.updateSession(session.id, { status: 'diarizing' })
    sessionService.updateSession(session.id, { status: 'anonymizing' })
    const docPath = join(tmpDir, `${session.id}.json`)
    writeFileSync(docPath, JSON.stringify(sampleDoc), 'utf-8')
    sessionService.updateSession(session.id, {
      status: 'review',
      anonymizedPath: docPath,
      entityMap: sampleEntityMap
    })
    return session.id
  }

  describe('load', () => {
    it('loads review data for a session in review status', () => {
      const sessionId = createReviewSession()
      const data = reviewService.load(sessionId)

      expect(data.sessionTitle).toBe('Test Session')
      expect(data.sessionType).toBe('audio')
      expect(data.document.type).toBe('doc')
      expect(data.document.content).toHaveLength(1)
      expect(data.entityMap.e1.original).toBe('Max Müller')
    })

    it('throws for non-existent session', () => {
      expect(() => reviewService.load('non-existent')).toThrow('not found')
    })

    it('throws for session not in review status', () => {
      const session = sessionService.createSession('Recording', 'audio')
      expect(() => reviewService.load(session.id)).toThrow('not in review status')
    })

    it('throws for session without anonymizedPath', () => {
      const session = sessionService.createSession('Test', 'audio')
      sessionService.updateSession(session.id, { status: 'transcribing' })
      sessionService.updateSession(session.id, { status: 'diarizing' })
      sessionService.updateSession(session.id, { status: 'anonymizing' })
      sessionService.updateSession(session.id, { status: 'review' })

      expect(() => reviewService.load(session.id)).toThrow('no anonymized document')
    })

    it('returns empty entityMap when session has none', () => {
      const session = sessionService.createSession('Test', 'audio')
      sessionService.updateSession(session.id, { status: 'transcribing' })
      sessionService.updateSession(session.id, { status: 'diarizing' })
      sessionService.updateSession(session.id, { status: 'anonymizing' })
      const docPath = join(tmpDir, `${session.id}.json`)
      writeFileSync(docPath, JSON.stringify(sampleDoc), 'utf-8')
      sessionService.updateSession(session.id, {
        status: 'review',
        anonymizedPath: docPath
      })

      const data = reviewService.load(session.id)
      expect(data.entityMap).toEqual({})
    })
  })

  describe('save', () => {
    it('saves updated document and entityMap', () => {
      const sessionId = createReviewSession()

      const updatedDoc: TipTapDocument = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Updated text.' }]
          }
        ]
      }
      const updatedEntityMap: EntityMap = {
        e2: {
          original: 'Berlin',
          placeholder: '[ORT 1]',
          type: 'ORT',
          source: 'blocklist'
        }
      }

      reviewService.save(sessionId, updatedDoc, updatedEntityMap)

      // Verify document was written to disk
      const data = reviewService.load(sessionId)
      expect(data.document.content[0].content?.[0]).toEqual({
        type: 'text',
        text: 'Updated text.'
      })
      expect(data.entityMap.e2.type).toBe('ORT')
    })

    it('throws for non-existent session', () => {
      expect(() => reviewService.save('non-existent', sampleDoc, sampleEntityMap)).toThrow(
        'not found'
      )
    })

    it('throws for session without anonymizedPath', () => {
      const session = sessionService.createSession('Test', 'audio')
      expect(() => reviewService.save(session.id, sampleDoc, sampleEntityMap)).toThrow(
        'no anonymized path'
      )
    })
  })
})
