import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: () => '/tmp/therascript-test'
}))

interface FakeStoreState {
  activeModels: {
    transcription: string | null
    diarization: string | null
    diarizationPipeline: string
    ner: string | null
    ocr: string
    summarization: string | null
  }
  modelsDownloaded: boolean
  reconcileEvents: unknown[]
  installedModelVersions: Record<string, { version: string; sha256: string; installedAt: string }>
}

vi.mock('../SettingsService', () => {
  const g = globalThis as unknown as { __autoActivateState: FakeStoreState }
  return {
    getSettings: () => ({
      get: (key: keyof FakeStoreState) => g.__autoActivateState[key],
      set: <K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
        g.__autoActivateState = { ...g.__autoActivateState, [key]: value }
      }
    }),
    initSettings: () => ({
      get: (key: keyof FakeStoreState) => g.__autoActivateState[key],
      set: <K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
        g.__autoActivateState = { ...g.__autoActivateState, [key]: value }
      }
    })
  }
})

let installedFiles: Set<string>
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((p: string) => installedFiles.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

import { autoActivateAfterDownload, getActiveModelIdBelief } from '../ModelDownloadService'

const MODELS_DIR = '/tmp/therascript-test/models'
const GEMMA_FILE = `${MODELS_DIR}/summarization/google_gemma-3-4b-it-Q4_K_M.gguf`

function setState(state: FakeStoreState): void {
  ;(globalThis as unknown as { __autoActivateState: FakeStoreState }).__autoActivateState = state
}

function getState(): FakeStoreState {
  return (globalThis as unknown as { __autoActivateState: FakeStoreState }).__autoActivateState
}

function freshState(over: Partial<FakeStoreState> = {}): void {
  setState({
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: null
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    installedModelVersions: {},
    ...over
  })
  installedFiles = new Set([GEMMA_FILE])
}

describe('autoActivateAfterDownload (Issue #103)', () => {
  beforeEach(() => {
    freshState()
    vi.clearAllMocks()
  })

  it('activates an optional model when its slot is null', () => {
    autoActivateAfterDownload('gemma-summarization')

    expect(getActiveModelIdBelief('summarization')).toBe('gemma-summarization')
    expect(getState().activeModels.summarization).toBe('gemma-summarization')
  })

  it('does NOT override an already-set optional slot', () => {
    const state = getState()
    state.activeModels.summarization = 'some-other-summarizer'
    setState(state)

    autoActivateAfterDownload('gemma-summarization')

    expect(getState().activeModels.summarization).toBe('some-other-summarizer')
  })

  it('does NOT auto-activate required-group models', () => {
    const state = getState()
    state.activeModels.transcription = null
    setState(state)

    autoActivateAfterDownload('whisper-large-v3-turbo')

    expect(getState().activeModels.transcription).toBeNull()
  })

  it('is a no-op for unknown model ids', () => {
    expect(() => autoActivateAfterDownload('does-not-exist')).not.toThrow()
    expect(getState().activeModels.summarization).toBeNull()
  })
})
