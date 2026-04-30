import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computePlannedSteps } from '../TaskQueueService'
import type { Session } from '../../../shared/types'

vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn(),
  isModelInstalled: vi.fn()
}))

import { getActiveModelId, isModelInstalled } from '../ModelDownloadService'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'T',
    type: 'audio',
    status: 'queued',
    audioPath: null,
    transcriptPath: null,
    anonymizedPath: null,
    diarizationPath: null,
    alignedTranscriptPath: null,
    pdfPath: null,
    extractedPath: null,
    entityMap: null,
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
    reviewAt: null,
    wordCount: null,
    summary: null,
    summaryModelId: null,
    summarizedAt: null,
    plannedSteps: null,
    retryCount: 0,
    ...overrides
  }
}

describe('computePlannedSteps — Issue #80 Phase H', () => {
  beforeEach(() => {
    vi.mocked(getActiveModelId).mockReturnValue('')
    vi.mocked(isModelInstalled).mockReturnValue(false)
  })

  describe('audio sessions', () => {
    it('omits summarization when no summarization model is active', () => {
      const session = makeSession({ type: 'audio' })
      expect(computePlannedSteps(session)).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization'
      ])
    })

    it('includes summarization when a model is active AND installed', () => {
      vi.mocked(getActiveModelId).mockReturnValue('gemma-3-4b')
      vi.mocked(isModelInstalled).mockReturnValue(true)
      const session = makeSession({ type: 'audio' })
      expect(computePlannedSteps(session)).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization',
        'summarization'
      ])
    })

    it('omits summarization when configured id points to a non-installed model', () => {
      vi.mocked(getActiveModelId).mockReturnValue('gemma-3-4b')
      vi.mocked(isModelInstalled).mockReturnValue(false)
      const session = makeSession({ type: 'audio' })
      expect(computePlannedSteps(session)).not.toContain('summarization')
    })

    it('omits summarization when getActiveModelId throws', () => {
      vi.mocked(getActiveModelId).mockImplementation(() => {
        throw new Error('settings store unavailable')
      })
      const session = makeSession({ type: 'audio' })
      expect(computePlannedSteps(session)).not.toContain('summarization')
    })
  })

  describe('pdf sessions', () => {
    it('returns extraction → anonymization without OCR or summarization by default', () => {
      const session = makeSession({ type: 'pdf' })
      expect(computePlannedSteps(session)).toEqual(['extraction', 'anonymization'])
    })

    it('includes OCR when pdfHasScannedPages === true', () => {
      // pdfHasScannedPages is added by Phase G's migration 013; cast for now.
      const session = makeSession({ type: 'pdf' }) as Session & { pdfHasScannedPages?: boolean }
      session.pdfHasScannedPages = true
      expect(computePlannedSteps(session)).toEqual(['extraction', 'ocr', 'anonymization'])
    })

    it('includes both OCR and summarization when conditions are met', () => {
      vi.mocked(getActiveModelId).mockReturnValue('gemma-3-4b')
      vi.mocked(isModelInstalled).mockReturnValue(true)
      const session = makeSession({ type: 'pdf' }) as Session & { pdfHasScannedPages?: boolean }
      session.pdfHasScannedPages = true
      expect(computePlannedSteps(session)).toEqual([
        'extraction',
        'ocr',
        'anonymization',
        'summarization'
      ])
    })
  })
})
