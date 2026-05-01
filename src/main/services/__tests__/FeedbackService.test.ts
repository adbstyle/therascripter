import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMock = vi.fn()
const isModelInstalledMock = vi.fn()
const getModelByIdMock = vi.fn()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.8.0' }
}))


vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: getMock })
}))

vi.mock('../ModelDownloadService', () => ({
  isModelInstalled: (id: string) => isModelInstalledMock(id),
  getModelById: (id: string) => getModelByIdMock(id)
}))

import {
  buildFeedbackContent,
  buildClipboardPayload,
  FEEDBACK_RECIPIENT
} from '../FeedbackService'

beforeEach(() => {
  vi.clearAllMocks()
  isModelInstalledMock.mockReturnValue(true)
  getModelByIdMock.mockImplementation((id: string) => ({ label: `Label of ${id}` }))
})

describe('buildFeedbackContent', () => {
  it('produces a German subject containing the version', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })

    const c = buildFeedbackContent()

    expect(c.recipient).toBe(FEEDBACK_RECIPIENT)
    expect(c.subject).toBe('Therascript Feedback – v0.8.0')
  })

  it('includes all required sections in the body', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })

    const { body } = buildFeedbackContent()

    expect(body).toContain('Beschreibung')
    expect(body).toContain('Erwartetes Verhalten')
    expect(body).toContain('Schritte zur Reproduktion')
    expect(body).toContain('App-Version: 0.8.0')
    expect(body).toMatch(/macOS: \S+/)
    expect(body).toMatch(/Chip: \S+/)
    expect(body).toContain('Transkription:')
    expect(body).toContain('Diarisierung:')
    expect(body).toContain('NER:')
    expect(body).toContain('Summarization:')
    expect(body).toContain('keine Patientendaten')
    expect(body).toContain('keine garantierte Antwortfrist')
  })

  it('renders empty summarization slot as "(deaktiviert)"', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: ''
    })

    const { body } = buildFeedbackContent()

    expect(body).toContain('Summarization: (deaktiviert)')
  })

  it('renders empty required slot as "(nicht installiert)"', () => {
    getMock.mockReturnValue({
      transcription: '',
      diarization: '',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: '',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })

    const { body } = buildFeedbackContent()

    expect(body).toContain('Transkription: (nicht installiert)')
    expect(body).toContain('Diarisierung: (nicht installiert)')
    expect(body).toContain('NER: (nicht installiert)')
  })

  it('marks an active but uninstalled model with "(nicht installiert)"', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })
    isModelInstalledMock.mockImplementation((id: string) => id !== 'gemma-summarization')

    const { body } = buildFeedbackContent()

    expect(body).toContain('Summarization: gemma-summarization (nicht installiert)')
  })

  it('builds a valid mailto URL', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })

    const { mailto } = buildFeedbackContent()

    expect(mailto.startsWith(`mailto:${FEEDBACK_RECIPIENT}?`)).toBe(true)
    expect(mailto).not.toContain('%40')
    expect(mailto).toContain('subject=')
    expect(mailto).toContain('body=')
  })
})

describe('buildClipboardPayload', () => {
  it('prefixes recipient and subject for the clipboard fallback', () => {
    getMock.mockReturnValue({
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    })

    const c = buildFeedbackContent()
    const payload = buildClipboardPayload(c)

    expect(payload.startsWith(`An: ${FEEDBACK_RECIPIENT}`)).toBe(true)
    expect(payload).toContain(`Betreff: ${c.subject}`)
    expect(payload).toContain('Beschreibung')
  })
})
