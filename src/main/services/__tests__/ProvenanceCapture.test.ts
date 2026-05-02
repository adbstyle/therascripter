import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetActiveModelId = vi.fn()
const mockGetModelById = vi.fn()
vi.mock('../ModelDownloadService', () => ({
  getActiveModelId: (...a: unknown[]) => mockGetActiveModelId(...a),
  getModelById: (...a: unknown[]) => mockGetModelById(...a)
}))

const mockSettingsGet = vi.fn()
vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: (...a: unknown[]) => mockSettingsGet(...a) })
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import { captureProcessedModels } from '../ProvenanceCapture'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHA = (c: string): string => c.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  // By default, settings has no installedModelVersions yet — every snapshot
  // falls back to version='unknown'. Tests override per case.
  mockSettingsGet.mockReturnValue({})
})

describe('captureProcessedModels', () => {
  it('snapshots active models for every step in plannedSteps', () => {
    mockGetActiveModelId.mockImplementation((group: string) => {
      if (group === 'asr') return 'whisper-large-v3-turbo'
      if (group === 'diarization') return 'pyannote-suite'
      if (group === 'ner') return 'flair-ner-german-large'
      if (group === 'summarization') return 'gemma-summarization'
      return null
    })
    mockGetModelById.mockImplementation((id: string) => ({
      id,
      label: `Label ${id}`,
      sha256: SHA('a'),
      sizeBytes: 100
    }))
    mockSettingsGet.mockReturnValue({
      'whisper-large-v3-turbo': { version: '2025-02-01', sha256: SHA('a'), installedAt: '' },
      'pyannote-suite': { version: '2025-03-12', sha256: SHA('a'), installedAt: '' },
      'flair-ner-german-large': { version: '2025-02-08', sha256: SHA('a'), installedAt: '' },
      'gemma-summarization': { version: '2025-04-01', sha256: SHA('a'), installedAt: '' }
    })

    const snap = captureProcessedModels([
      'diarization',
      'transcription',
      'alignment',
      'anonymization',
      'summarization'
    ])

    expect(snap.asr?.id).toBe('whisper-large-v3-turbo')
    expect(snap.asr?.version).toBe('2025-02-01')
    expect(snap.asr?.sizeBytes).toBe(100)
    expect(snap.diarization?.id).toBe('pyannote-suite')
    expect(snap.ner?.id).toBe('flair-ner-german-large')
    expect(snap.summarization?.id).toBe('gemma-summarization')
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns null per group when the step is not in plannedSteps', () => {
    // PDF pipeline: only extraction → ocr → anonymization → summarization;
    // no transcription, no diarization.
    mockGetActiveModelId.mockReturnValue('flair-ner-german-large')
    mockGetModelById.mockReturnValue({
      id: 'flair-ner-german-large',
      label: 'flair NER',
      sha256: SHA('b'),
      sizeBytes: 200
    })

    const snap = captureProcessedModels(['extraction', 'ocr', 'anonymization'])

    expect(snap.asr).toBeNull()
    expect(snap.diarization).toBeNull()
    expect(snap.summarization).toBeNull()
    expect(snap.ner?.id).toBe('flair-ner-german-large')
  })

  it('returns null for a group whose active model id is null (defensive)', () => {
    // Reconciler may have cleared the slot mid-flight; capture gracefully.
    mockGetActiveModelId.mockReturnValue(null)
    const snap = captureProcessedModels([
      'diarization',
      'transcription',
      'anonymization',
      'summarization'
    ])
    expect(snap.asr).toBeNull()
    expect(snap.diarization).toBeNull()
    expect(snap.ner).toBeNull()
    expect(snap.summarization).toBeNull()
  })

  it('falls back to version="unknown" when installedModelVersions has no entry', () => {
    mockGetActiveModelId.mockReturnValue('whisper-large-v3-turbo')
    mockGetModelById.mockReturnValue({
      id: 'whisper-large-v3-turbo',
      label: 'Whisper',
      sha256: SHA('a'),
      sizeBytes: 100
    })
    mockSettingsGet.mockReturnValue({}) // no record

    const snap = captureProcessedModels(['transcription'])
    expect(snap.asr?.version).toBe('unknown')
  })
})
