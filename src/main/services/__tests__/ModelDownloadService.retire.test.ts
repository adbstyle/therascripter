import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: () => '/tmp/therascript-test'
}))

interface FakeStoreState {
  activeModels: Record<string, string | null>
  modelsDownloaded: boolean
  reconcileEvents: Array<Record<string, unknown>>
  pendingModelUpdates: Array<{ id: string }> | null
}

let storeState: FakeStoreState

const mockSettingsStore = {
  get: vi.fn((key: keyof FakeStoreState) => storeState[key]),
  set: vi.fn(<K extends keyof FakeStoreState>(key: K, value: FakeStoreState[K]) => {
    storeState = { ...storeState, [key]: value }
  })
}
vi.mock('../SettingsService', () => ({
  getSettings: () => mockSettingsStore,
  initSettings: () => mockSettingsStore
}))

const deleteInstalledVersion = vi.fn()
vi.mock('../InstalledVersionsStore', () => ({
  deleteInstalledVersion: (id: string) => deleteInstalledVersion(id),
  setInstalledVersion: vi.fn()
}))

let files: Set<string>
const rmSync = vi.fn((p: string) => {
  files.delete(p)
})
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((p: string) => files.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: (p: string) => rmSync(p)
  }
  return { ...fsMock, default: fsMock }
})

import {
  checkRequiredAndActiveExist,
  getModelsToLoadOnFirstLaunch,
  retireObsoleteModels,
  reconcileActiveModels
} from '../ModelDownloadService'

const GEMMA3 = '/tmp/therascript-test/models/summarization/google_gemma-3-4b-it-Q4_K_M.gguf'
const GEMMA4 = '/tmp/therascript-test/models/summarization/gemma-4-E2B_q4_0-it.gguf'
const REQUIRED_FILES = [
  '/tmp/therascript-test/models/asr/ggml-large-v3-turbo-q5_0.bin',
  '/tmp/therascript-test/models/diarization/models--pyannote--speaker-diarization-community-1',
  '/tmp/therascript-test/models/ner/hf/hub/models--xlm-roberta-large'
]

function state(summarization: string | null): FakeStoreState {
  return {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization
    },
    modelsDownloaded: true,
    reconcileEvents: [],
    pendingModelUpdates: null
  }
}

describe('retireObsoleteModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    files = new Set(REQUIRED_FILES)
  })

  it('deletes the active Gemma 3 file, clears the slot and reports model-retired', () => {
    storeState = state('gemma-summarization')
    files.add(GEMMA3)

    retireObsoleteModels()

    expect(rmSync).toHaveBeenCalledWith(GEMMA3)
    expect(files.has(GEMMA3)).toBe(false)
    expect(deleteInstalledVersion).toHaveBeenCalledWith('gemma-summarization')
    expect(storeState.activeModels.summarization).toBeNull()
    expect(storeState.reconcileEvents).toEqual([
      expect.objectContaining({
        group: 'summarization',
        fromModelId: 'gemma-summarization',
        fromLabel: 'Gemma 3 4B Instruct',
        toModelId: null,
        toLabel: null,
        reason: 'model-retired',
        status: 'pending'
      })
    ])
  })

  it('deletes an inactive Gemma 3 file silently and keeps the active successor', () => {
    storeState = state('gemma-4-e2b-summarization')
    files.add(GEMMA3)
    files.add(GEMMA4)

    retireObsoleteModels()

    expect(files.has(GEMMA3)).toBe(false)
    expect(storeState.activeModels.summarization).toBe('gemma-4-e2b-summarization')
    expect(storeState.reconcileEvents).toEqual([])
  })

  it('clears a slot that still names Gemma 3 even when the file is already gone', () => {
    storeState = state('gemma-summarization')

    retireObsoleteModels()

    expect(storeState.activeModels.summarization).toBeNull()
    expect(storeState.reconcileEvents).toHaveLength(1)
  })

  it('removes leftovers of an interrupted download and an interrupted update swap', () => {
    storeState = state(null)
    const leftovers = [
      `${GEMMA3}.partial`,
      '/tmp/therascript-test/models/.backup/gemma-summarization',
      '/tmp/therascript-test/models/gemma-summarization.tar.gz.partial'
    ]
    leftovers.forEach((p) => files.add(p))

    retireObsoleteModels()

    for (const p of leftovers) expect(files.has(p)).toBe(false)
    expect(storeState.reconcileEvents).toEqual([])
  })

  it('is a no-op on the second run', () => {
    storeState = state('gemma-summarization')
    files.add(GEMMA3)

    retireObsoleteModels()
    const settingsWrites = mockSettingsStore.set.mock.calls.length
    retireObsoleteModels()

    expect(mockSettingsStore.set.mock.calls.length).toBe(settingsWrites)
    expect(storeState.reconcileEvents).toHaveLength(1)
  })

  it('leaves nothing for the reconciler to misreport as missing', () => {
    storeState = state('gemma-summarization')
    files.add(GEMMA3)

    retireObsoleteModels()
    const repairs = reconcileActiveModels()

    expect(repairs).toEqual([])
    expect(storeState.reconcileEvents.map((e) => e.reason)).toEqual(['model-retired'])
  })

  // ─── Pflichtgruppe ASR: Swiss-German-Fine-Tune (CC BY-NC, #185) ──────────

  const SWISS = '/tmp/therascript-test/models/asr/ggml-large-v3-turbo-swiss-q5_0.bin'
  const DEFAULT_ASR = '/tmp/therascript-test/models/asr/ggml-large-v3-turbo-q5_0.bin'
  const GERMAN_ASR = '/tmp/therascript-test/models/asr/ggml-large-v3-turbo-german-q5_0.bin'
  const withSwissActive = (): FakeStoreState => {
    const s = state(null)
    return {
      ...s,
      activeModels: { ...s.activeModels, transcription: 'whisper-large-v3-turbo-swiss' }
    }
  }

  it('replaces an active Swiss model by the installed default in one event', () => {
    storeState = withSwissActive()
    files.add(SWISS)

    retireObsoleteModels()
    reconcileActiveModels()

    expect(files.has(SWISS)).toBe(false)
    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo')
    // Der Reconciler ergänzt das Retire-Event um den Nachfolger statt ein
    // zweites «Standard aktiviert» anzulegen.
    expect(storeState.reconcileEvents).toEqual([
      expect.objectContaining({
        group: 'asr',
        fromModelId: 'whisper-large-v3-turbo-swiss',
        fromLabel: 'Whisper Large V3 Turbo (Swiss-German)',
        toModelId: 'whisper-large-v3-turbo',
        toLabel: 'Whisper Large V3 Turbo',
        reason: 'model-retired'
      })
    ])
  })

  it('falls back to another installed ASR model when the default is missing', () => {
    storeState = withSwissActive()
    files.delete(DEFAULT_ASR)
    files.add(SWISS)
    files.add(GERMAN_ASR)

    retireObsoleteModels()
    reconcileActiveModels()

    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo-german')
    expect(storeState.reconcileEvents).toEqual([
      expect.objectContaining({
        toModelId: 'whisper-large-v3-turbo-german',
        reason: 'model-retired'
      })
    ])
  })

  it('without another ASR model: first launch loads the default and the notice names it', () => {
    storeState = withSwissActive()
    files.delete(DEFAULT_ASR)
    files.add(SWISS)

    retireObsoleteModels()
    reconcileActiveModels()

    // Boot: kein ASR-Modell → Ersteinrichtung nötig, sie lädt den Standard.
    expect(storeState.activeModels.transcription).toBeNull()
    expect(checkRequiredAndActiveExist(null, 'pyannote-suite')).toBe(false)
    expect(getModelsToLoadOnFirstLaunch(null).map((m) => m.id)).toContain('whisper-large-v3-turbo')

    // Nach dem Download (startModelDownload ruft den Reconciler erneut):
    files.add(DEFAULT_ASR)
    reconcileActiveModels()

    expect(storeState.activeModels.transcription).toBe('whisper-large-v3-turbo')
    expect(storeState.reconcileEvents).toEqual([
      expect.objectContaining({
        fromModelId: 'whisper-large-v3-turbo-swiss',
        toModelId: 'whisper-large-v3-turbo',
        reason: 'model-retired',
        status: 'pending'
      })
    ])
  })

  it('does not treat an unknown active ASR id as ready while the default is missing', () => {
    files.delete(DEFAULT_ASR)
    expect(checkRequiredAndActiveExist('whisper-large-v3-turbo-swiss', 'pyannote-suite')).toBe(
      false
    )

    files.add(DEFAULT_ASR)
    expect(checkRequiredAndActiveExist('whisper-large-v3-turbo-swiss', 'pyannote-suite')).toBe(true)
  })
})
