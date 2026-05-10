import { describe, it, expect, vi, beforeEach } from 'vitest'

interface ActiveModels {
  transcription: string | null
  diarization: string | null
  diarizationPipeline: string
  ner: string | null
  ocr: string
  summarization?: string | null
}

interface FakeStoreState {
  activeModels: ActiveModels
  modelsDownloaded: boolean
  reconcileEvents: unknown[]
  installedModelVersions: Record<string, unknown>
  dismissedManifestVersions: string[]
}

// vi.mock-Factories werden gehoisted und dürfen keine Top-Level-Variablen
// referenzieren. storeState wird via globalThis indirekt von der Factory
// und den Tests geteilt.

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: (key: keyof FakeStoreState) =>
      (globalThis as unknown as { __settingsStoreState: FakeStoreState }).__settingsStoreState[key],
    set: <K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
      const g = globalThis as unknown as { __settingsStoreState: FakeStoreState }
      g.__settingsStoreState = { ...g.__settingsStoreState, [key]: value }
    }
  }))
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') }
}))

// WICHTIG: Mock muss ALLE Symbole exportieren, die SettingsService aus
// ModelDownloadService importiert — sonst resolvt der Import auf undefined
// und die Migration crasht zur Laufzeit ("undefined is not a function").
// Aktuelle Imports: getModelDefinitions, defaultActiveModelFor.
vi.mock('../ModelDownloadService', () => ({
  getModelDefinitions: () => [
    { id: 'whisper-large-v3-turbo', group: 'asr' },
    { id: 'pyannote-suite', group: 'diarization' },
    { id: 'flair-ner-german-large', group: 'ner' },
    { id: 'gemma-summarization', group: 'summarization' }
  ],
  // Spiegelt das Production-Verhalten: optionale Gruppen → null,
  // required Groups → catalog default.
  defaultActiveModelFor: (group: string): string | null => {
    if (group === 'summarization') return null
    if (group === 'asr') return 'whisper-large-v3-turbo'
    if (group === 'diarization') return 'pyannote-suite'
    if (group === 'ner') return 'flair-ner-german-large'
    return null
  }
}))

import { initSettings, _resetSettingsForTests } from '../SettingsService'

function preLlmStoreState(): FakeStoreState {
  return {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision'
      // KEIN summarization-Key — pre-LLM-Version hatte das Feld nicht
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    installedModelVersions: {},
    dismissedManifestVersions: []
  }
}

function setStoreState(state: FakeStoreState): void {
  ;(globalThis as unknown as { __settingsStoreState: FakeStoreState }).__settingsStoreState = state
}

function getStoreState(): FakeStoreState {
  return (globalThis as unknown as { __settingsStoreState: FakeStoreState }).__settingsStoreState
}

describe('summarization upgrade migration (Issue #103)', () => {
  beforeEach(() => {
    _resetSettingsForTests()
    vi.clearAllMocks()
  })

  it('writes null (not gemma-summarization) into a missing summarization slot for pre-LLM upgraders', () => {
    setStoreState(preLlmStoreState())

    initSettings()

    expect(getStoreState().activeModels.summarization).toBeNull()
  })

  it('preserves an explicit gemma-summarization slot for users who already activated it', () => {
    setStoreState({
      ...preLlmStoreState(),
      activeModels: {
        ...preLlmStoreState().activeModels,
        summarization: 'gemma-summarization'
      }
    })

    initSettings()

    expect(getStoreState().activeModels.summarization).toBe('gemma-summarization')
  })

  it('preserves an explicit null slot (user deactivated summarization)', () => {
    setStoreState({
      ...preLlmStoreState(),
      activeModels: {
        ...preLlmStoreState().activeModels,
        summarization: null
      }
    })

    initSettings()

    expect(getStoreState().activeModels.summarization).toBeNull()
  })
})
