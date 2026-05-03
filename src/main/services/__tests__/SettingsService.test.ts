import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

interface ActiveModels {
  transcription: string | null
  diarization: string | null
  diarizationPipeline: string
  ner: string | null
  ocr: string
  summarization: string | null
}

interface FakeStoreState {
  activeModels: ActiveModels
  reconcileEvents: unknown[]
  dismissedManifestVersions: unknown[]
  installedModelVersions: Record<string, unknown>
}

let storeState: FakeStoreState

// electron-store constructor is called inside initSettings; mock it to read
// from / write to the fake state above so the test can introspect post-init.
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      get<K extends keyof FakeStoreState>(key: K): FakeStoreState[K] {
        return storeState[key]
      }
      set<K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]): void {
        storeState = { ...storeState, [key]: value }
      }
    }
  }
})

// initSettings reads getModelDefinitions for the known-id sets; let it use
// the real catalog (deterministic, no env required).

// ─── Import after mocks ───────────────────────────────────────────────────────

import { initSettings, _resetSettingsForTests } from '../SettingsService'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshState(over: Partial<FakeStoreState> = {}): void {
  storeState = {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: 'gemma-summarization'
    },
    reconcileEvents: [],
    dismissedManifestVersions: [],
    installedModelVersions: {},
    ...over
  }
}

beforeEach(() => {
  freshState()
  _resetSettingsForTests()
  vi.clearAllMocks()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('initSettings — Issue #84 boot-loop regression guard', () => {
  it('preserves a null ner slot (post-reconciler state) instead of resetting it', () => {
    // Reconciler from the previous boot cleared ner because the model file
    // was missing. A naive "unknown value → reset" guard would now overwrite
    // null with the catalog default, only to have the reconciler clear it
    // again on the next launch — emitting a fresh ReconcileEvent every boot.
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: null,
        ocr: 'apple-vision',
        summarization: 'gemma-summarization'
      }
    })

    initSettings()

    expect(storeState.activeModels.ner).toBeNull()
  })

  it('preserves a null diarization slot (Story C invariant, regression guard)', () => {
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: null,
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision',
        summarization: 'gemma-summarization'
      }
    })

    initSettings()

    expect(storeState.activeModels.diarization).toBeNull()
  })

  it('still resets a truly unknown ner string back to the catalog default', () => {
    freshState({
      activeModels: {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-suite',
        diarizationPipeline: 'pyannote/speaker-diarization-3.1',
        // Legacy ID from a reverted multi-backend iteration; the migration
        // SHOULD reset this so AnonymizationService does not abort.
        ner: 'ai4privacy/gliner',
        ocr: 'apple-vision',
        summarization: 'gemma-summarization'
      }
    })

    initSettings()

    expect(storeState.activeModels.ner).toBe('flair-ner-german-large')
  })
})
