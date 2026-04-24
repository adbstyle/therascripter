import { describe, it, expect, vi } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/tmp/therascript-test') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

vi.mock('../../db/connection', () => ({
  getDataDir: () => '/tmp/therascript-test'
}))

const mockSettingsStore = {
  get: vi.fn((key: string) => {
    if (key === 'activeModels') {
      return {
        transcription: 'whisper-large-v3-turbo',
        diarization: 'pyannote-speaker-diarization-3.1',
        ner: 'flair-ner-german-large',
        ocr: 'apple-vision'
      }
    }
    return undefined
  }),
  set: vi.fn()
}
vi.mock('../SettingsService', () => ({
  getSettings: () => mockSettingsStore,
  initSettings: () => mockSettingsStore
}))

vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

// Import after mocks
import {
  getAsrModels,
  getRequiredModels,
  getModelById,
  getModelsToLoadOnFirstLaunch,
  downloadSingleModel,
  deleteModel,
  setActiveAsrModel
} from '../ModelDownloadService'

describe('ModelDownloadService catalog helpers', () => {
  it('getAsrModels returns all models with group="asr"', () => {
    const asrs = getAsrModels()
    expect(asrs.length).toBeGreaterThanOrEqual(2)
    expect(asrs.every((m) => m.group === 'asr')).toBe(true)
  })

  it('getRequiredModels returns only flair (pyannote is now group-required, not isRequired)', () => {
    const required = getRequiredModels()
    expect(required.map((m) => m.id).sort()).toEqual(['flair-ner-german-large'])
  })

  it('getModelById returns definition or null', () => {
    expect(getModelById('whisper-large-v3-turbo')?.group).toBe('asr')
    expect(getModelById('does-not-exist')).toBeNull()
  })

  it('getModelsToLoadOnFirstLaunch returns required + activeAsrId + activeDiarId', () => {
    const loaded = getModelsToLoadOnFirstLaunch(
      'whisper-large-v3-turbo',
      'pyannote-speaker-diarization-3.1'
    )
    const ids = loaded.map((m) => m.id).sort()
    expect(ids).toEqual([
      'flair-ner-german-large',
      'pyannote-speaker-diarization-3.1',
      'whisper-large-v3-turbo'
    ])
  })

  it('getModelsToLoadOnFirstLaunch falls back gracefully on unknown ids', () => {
    const loaded = getModelsToLoadOnFirstLaunch('nonexistent', 'also-nonexistent')
    expect(loaded.map((m) => m.id).sort()).toEqual(['flair-ner-german-large'])
  })
})

describe('downloadSingleModel', () => {
  it('throws when model id is unknown', async () => {
    await expect(downloadSingleModel('does-not-exist')).rejects.toThrow(
      /unbekanntes Modell/i
    )
  })

  it('throws when model is not in a downloadable group (ner)', async () => {
    await expect(downloadSingleModel('flair-ner-german-large')).rejects.toThrow(
      /nur ASR- und Diarization-Modelle/i
    )
  })
})

describe('deleteModel', () => {
  it('throws when model id is unknown', async () => {
    await expect(deleteModel('does-not-exist')).rejects.toThrow(/unbekanntes Modell/i)
  })

  it('throws when model is required (flair)', async () => {
    await expect(deleteModel('flair-ner-german-large')).rejects.toThrow(/Pflicht-Modell/i)
  })

  it('throws when attempting to delete the active asr model', async () => {
    // Mock returns activeModels.transcription = 'whisper-large-v3-turbo'
    await expect(deleteModel('whisper-large-v3-turbo')).rejects.toThrow(
      /als ASR-Modell aktiv/i
    )
  })

  it('throws when attempting to delete the active diarization model', async () => {
    // Mock returns activeModels.diarization = 'pyannote-speaker-diarization-3.1'
    await expect(deleteModel('pyannote-speaker-diarization-3.1')).rejects.toThrow(
      /als Sprechererkennungs-Modell aktiv/i
    )
  })
})

describe('setActiveAsrModel', () => {
  it('throws when model id is unknown', () => {
    expect(() => setActiveAsrModel('nope')).toThrow(/unbekanntes Modell/i)
  })

  it('throws when model is not in asr group', () => {
    expect(() => setActiveAsrModel('pyannote-speaker-diarization-3.1')).toThrow(
      /ist diarization, erwartet wurde asr/i
    )
  })

  it('throws when model is not installed', () => {
    // Swiss-German is in the catalog but not on disk (existsSync mocked to false)
    expect(() => setActiveAsrModel('whisper-large-v3-turbo-swiss')).toThrow(
      /nicht installiert/i
    )
  })
})
