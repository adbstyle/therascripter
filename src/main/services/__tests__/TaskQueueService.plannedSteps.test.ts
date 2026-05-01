import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computePlannedSteps } from '../TaskQueueService'
import type { Session } from '../../../shared/types'

vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: vi.fn()
}))

import { getActiveModelId } from '../ModelDownloadService'

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
    pdfHasScannedPages: null,
    ...overrides
  }
}

// Issue #84 / Story C — getActiveModelId now does the disk-presence check
// internally and returns null on missing-or-unknown-or-not-installed. The
// computePlannedSteps test bed therefore only needs to mock
// getActiveModelId; isModelInstalled no longer participates in the decision.
describe('computePlannedSteps — Issue #80 Phase H', () => {
  beforeEach(() => {
    vi.mocked(getActiveModelId).mockReturnValue(null)
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
      const session = makeSession({ type: 'audio' })
      expect(computePlannedSteps(session)).toEqual([
        'diarization',
        'transcription',
        'alignment',
        'anonymization',
        'summarization'
      ])
    })

    it('omits summarization when getActiveModelId returns null (slot empty or file missing)', () => {
      vi.mocked(getActiveModelId).mockReturnValue(null)
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
