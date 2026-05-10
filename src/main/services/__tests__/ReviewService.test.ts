import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ReviewService } from '../ReviewService'
import { SessionService } from '../SessionService'
import type { TipTapDocument } from '../../../shared/types/TipTapDocument'
import type { EntityMap } from '../../../shared/types'
import type { TranscriptData } from '../../../shared/types/Transcript'
import type { DiarizationData } from '../../../shared/types/Diarization'
import { applyTestSchema } from '../../db/__tests__/test-utils'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/home')
  }
}))

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
    applyTestSchema(db)
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
    sessionService.updateSession(session.id, { status: 'queued' })
    sessionService.updateSession(session.id, { status: 'processing' })
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
      sessionService.updateSession(session.id, { status: 'queued' })
      sessionService.updateSession(session.id, { status: 'processing' })
      sessionService.updateSession(session.id, { status: 'review' })

      expect(() => reviewService.load(session.id)).toThrow('no anonymized document')
    })

    it('returns empty entityMap when session has none', () => {
      const session = sessionService.createSession('Test', 'audio')
      sessionService.updateSession(session.id, { status: 'queued' })
      sessionService.updateSession(session.id, { status: 'processing' })
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

  describe('audioStats aggregation (Issue #99)', () => {
    function writeJson(p: string, data: unknown): void {
      writeFileSync(p, JSON.stringify(data), 'utf-8')
    }

    function createAudioReviewSessionWithFiles(opts: {
      transcript?: TranscriptData
      diarization?: DiarizationData
    }): string {
      const session = sessionService.createSession('Audio Test', 'audio')
      sessionService.updateSession(session.id, { status: 'queued' })
      sessionService.updateSession(session.id, { status: 'processing' })
      const docPath = join(tmpDir, `${session.id}.anon.json`)
      writeFileSync(docPath, JSON.stringify(sampleDoc), 'utf-8')
      const update: Parameters<typeof sessionService.updateSession>[1] = {
        status: 'review',
        anonymizedPath: docPath
      }
      if (opts.transcript) {
        const transcriptPath = join(tmpDir, `${session.id}.transcript.json`)
        writeJson(transcriptPath, opts.transcript)
        update.transcriptPath = transcriptPath
      }
      if (opts.diarization) {
        const diarizationPath = join(tmpDir, `${session.id}.diarization.json`)
        writeJson(diarizationPath, opts.diarization)
        update.diarizationPath = diarizationPath
      }
      sessionService.updateSession(session.id, update)
      return session.id
    }

    it('reads stitchMap + diarization when both files are present', () => {
      const sessionId = createAudioReviewSessionWithFiles({
        transcript: {
          words: [],
          segments: [],
          metadata: {
            model: 'whisper-cli',
            language: 'de',
            duration: 329,
            stitchMap: {
              segments: [],
              paddingSec: 0.2,
              stitchedDurationSec: 252,
              originalDurationSec: 329
            }
          }
        },
        diarization: {
          speakers: [
            { label: 'SPEAKER_00', start: 0, end: 100 },
            { label: 'SPEAKER_01', start: 100, end: 200 }
          ],
          speakerCount: 2,
          metadata: { model: 'pyannote/speaker-diarization-community-1', duration: 329 }
        }
      })

      const data = reviewService.load(sessionId)
      expect(data.audioStats).toEqual({
        originalDurationSec: 329,
        stitchedDurationSec: 252,
        speakerCount: 2,
        diarizationModel: 'pyannote/speaker-diarization-community-1'
      })
    })

    it('synthesizes stitchedDurationSec=0 for empty-speech sessions (no stitchMap, speakerCount=0)', () => {
      const sessionId = createAudioReviewSessionWithFiles({
        transcript: {
          words: [],
          segments: [],
          metadata: { model: 'whisper-cli', language: 'de', duration: 60 }
        },
        diarization: {
          speakers: [],
          speakerCount: 0,
          metadata: { model: 'pyannote/speaker-diarization-3.1', duration: 60 }
        }
      })

      const data = reviewService.load(sessionId)
      expect(data.audioStats).toEqual({
        originalDurationSec: 60,
        stitchedDurationSec: 0,
        speakerCount: 0,
        diarizationModel: 'pyannote/speaker-diarization-3.1'
      })
    })

    it('keeps stitchedDurationSec null for legacy sessions (no stitchMap, speakerCount>0)', () => {
      const sessionId = createAudioReviewSessionWithFiles({
        transcript: {
          words: [],
          segments: [],
          metadata: { model: 'whisper-cli', language: 'de', duration: 200 }
        },
        diarization: {
          speakers: [{ label: 'SPEAKER_00', start: 0, end: 100 }],
          speakerCount: 1,
          metadata: { model: 'pyannote/speaker-diarization-3.1', duration: 200 }
        }
      })

      const data = reviewService.load(sessionId)
      expect(data.audioStats).toEqual({
        originalDurationSec: 200,
        stitchedDurationSec: null,
        speakerCount: 1,
        diarizationModel: 'pyannote/speaker-diarization-3.1'
      })
    })

    it('falls through gracefully when both files are missing on disk', () => {
      const sessionId = createAudioReviewSessionWithFiles({})
      const data = reviewService.load(sessionId)
      expect(data.audioStats).toEqual({
        originalDurationSec: null,
        stitchedDurationSec: null,
        speakerCount: null,
        diarizationModel: null
      })
    })

    it('does not crash on corrupt diarization JSON; transcript-derived fields still surface', () => {
      const session = sessionService.createSession('Corrupt Diar', 'audio')
      sessionService.updateSession(session.id, { status: 'queued' })
      sessionService.updateSession(session.id, { status: 'processing' })
      const docPath = join(tmpDir, `${session.id}.anon.json`)
      writeFileSync(docPath, JSON.stringify(sampleDoc), 'utf-8')
      const transcriptPath = join(tmpDir, `${session.id}.transcript.json`)
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          words: [],
          segments: [],
          metadata: {
            model: 'whisper-cli',
            language: 'de',
            duration: 100,
            stitchMap: {
              segments: [],
              paddingSec: 0.2,
              stitchedDurationSec: 50,
              originalDurationSec: 100
            }
          }
        }),
        'utf-8'
      )
      const diarizationPath = join(tmpDir, `${session.id}.diarization.json`)
      writeFileSync(diarizationPath, '{ this is not valid JSON', 'utf-8')
      sessionService.updateSession(session.id, {
        status: 'review',
        anonymizedPath: docPath,
        transcriptPath,
        diarizationPath
      })

      const data = reviewService.load(session.id)
      expect(data.audioStats).toEqual({
        originalDurationSec: 100,
        stitchedDurationSec: 50,
        speakerCount: null,
        diarizationModel: null
      })
    })

    it('returns audioStats=null for PDF sessions', () => {
      const session = sessionService.createSession('PDF Test', 'pdf')
      sessionService.updateSession(session.id, { status: 'processing' })
      const docPath = join(tmpDir, `${session.id}.anon.json`)
      writeFileSync(docPath, JSON.stringify(sampleDoc), 'utf-8')
      sessionService.updateSession(session.id, {
        status: 'review',
        anonymizedPath: docPath
      })

      const data = reviewService.load(session.id)
      expect(data.audioStats).toBeNull()
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
