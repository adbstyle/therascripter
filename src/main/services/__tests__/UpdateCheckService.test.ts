import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockReaddirSync = vi.fn().mockReturnValue([])
const mockRenameSync = vi.fn()
const mockRmSync = vi.fn()

vi.mock('fs', () => {
  const fsMock = {
    existsSync: (...a: unknown[]) => mockExistsSync(...a),
    mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
    readdirSync: (...a: unknown[]) => mockReaddirSync(...a),
    renameSync: (...a: unknown[]) => mockRenameSync(...a),
    rmSync: (...a: unknown[]) => mockRmSync(...a)
  }
  return { ...fsMock, default: fsMock }
})

const mockGet = vi.fn()
vi.mock('https', () => {
  const httpsMock = { get: (...a: unknown[]) => mockGet(...a) }
  return { ...httpsMock, default: httpsMock }
})

const mockIsModelInstalled = vi.fn((_id: string) => true)

const mockSettingsStore = {
  get: vi.fn(),
  set: vi.fn()
}
vi.mock('../SettingsService', () => ({
  getSettings: () => mockSettingsStore
}))

vi.mock('../ModelDownloadService', () => ({
  getModelsDir: () => '/mock/models',
  getModelDefinitions: () => [
    {
      id: 'whisper-large-v3-turbo',
      label: 'Spracherkennung',
      url: 'https://example.com/whisper.bin',
      sha256: 'aaaa' + 'a'.repeat(60),
      relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
      checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin',
      sizeBytes: 100,
      archive: false
    },
    {
      id: 'pyannote-suite',
      label: 'Sprechererkennung',
      url: 'https://example.com/pyannote.tar.gz',
      sha256: 'bbbb' + 'b'.repeat(60),
      relativePath: 'diarization',
      checkPath: 'diarization/models--pyannote--speaker-diarization-3.1',
      sizeBytes: 200,
      archive: true
    }
  ],
  isModelInstalled: (id: string) => mockIsModelInstalled(id)
}))

const mockVerifyFileSha256 = vi.fn()
vi.mock('../DownloadService', () => ({
  verifyFileSha256: (...a: unknown[]) => mockVerifyFileSha256(...a)
}))

// Signatur: standardmässig gültig — eigene Tests prüfen den Ablehnungsfall
const mockVerifySignature = vi.fn().mockReturnValue(true)
vi.mock('../ManifestSignature', () => ({
  verifyManifestSignature: (...a: unknown[]) => mockVerifySignature(...a)
}))

const mockHandleManifest = vi.fn()
const mockHandleCheckFailed = vi.fn()
vi.mock('../app-update-deps', () => ({
  getAppUpdateService: () => ({
    handleManifest: mockHandleManifest,
    handleCheckFailed: mockHandleCheckFailed
  })
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  checkForUpdates,
  cleanupIncompleteUpdates,
  migrateInstalledVersions
} from '../UpdateCheckService'
import { isNewerVersion } from '../../../shared/version'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHttpsResponse(statusCode: number, body: string): void {
  mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const listeners: Record<string, ((data?: unknown) => void)[]> = {}
    const response = {
      statusCode,
      on: (event: string, handler: (data?: unknown) => void) => {
        listeners[event] = listeners[event] ?? []
        listeners[event].push(handler)
      },
      destroy: vi.fn()
    }
    cb(response)
    // Emit data + end
    listeners['data']?.forEach((h) => h(Buffer.from(body)))
    listeners['end']?.forEach((h) => h())
    return { on: vi.fn(), setTimeout: vi.fn() }
  })
}

function makeHttpsError(message: string): void {
  mockGet.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
    const req = {
      on: (event: string, handler: (err: Error) => void) => {
        if (event === 'error') handler(new Error(message))
      },
      setTimeout: vi.fn()
    }
    return req
  })
}

const validManifestModels = [
  {
    id: 'whisper-large-v3-turbo',
    version: '2025-02-01',
    label: 'Spracherkennung',
    url: 'https://example.com/whisper.bin',
    sha256: 'cccc' + 'c'.repeat(60), // different from installed aaaa...
    sizeBytes: 100
  },
  {
    id: 'pyannote-suite',
    version: '2025-02-01',
    label: 'Sprechererkennung',
    url: 'https://example.com/pyannote.tar.gz',
    sha256: 'bbbb' + 'b'.repeat(60), // same as installed — no update
    sizeBytes: 200
  }
]

const validManifest = JSON.stringify({
  generatedAt: '2025-01-15T00:00:00Z',
  models: validManifestModels
})

// ─── Tests ───────────────────────────────────────────────────────────────────

const appEntry = {
  version: '1.0.0',
  url: 'https://github.com/adbstyle/therascripter/releases/download/v1.0.0/Therascript.dmg',
  sha256: 'd'.repeat(64),
  sizeBytes: 300
}

describe('checkForUpdates — Übergabe an das Update (#167)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifySignature.mockReturnValue(true)
    mockIsModelInstalled.mockReturnValue(true)
    mockSettingsStore.get.mockReturnValue({})
  })

  it('übergibt die geprüfte Beschreibung mit App und Modellen', async () => {
    makeHttpsResponse(
      200,
      JSON.stringify({
        generatedAt: '2025-01-15T00:00:00Z',
        app: appEntry,
        models: validManifestModels
      })
    )
    await checkForUpdates()
    expect(mockHandleManifest).toHaveBeenCalledWith({
      generatedAt: '2025-01-15T00:00:00Z',
      app: appEntry,
      models: validManifestModels
    })
  })

  it('verwirft nur einen fehlerhaften Modell-Eintrag', async () => {
    const broken = { ...validManifestModels[0], id: '../evil' }
    makeHttpsResponse(
      200,
      JSON.stringify({
        generatedAt: '2025-01-15T00:00:00Z',
        models: [broken, validManifestModels[1]]
      })
    )
    await checkForUpdates()
    expect(mockHandleManifest.mock.calls[0][0].models.map((m: { id: string }) => m.id)).toEqual([
      'pyannote-suite'
    ])
  })

  it.each([
    ['Netzwerkfehler', () => makeHttpsError('Connection refused')],
    ['HTTP 404', () => makeHttpsResponse(404, '')],
    ['ungültiges JSON', () => makeHttpsResponse(200, 'not json {{')],
    ['falsches Gerüst', () => makeHttpsResponse(200, JSON.stringify({ models: [] }))]
  ])('meldet eine gescheiterte Prüfung (%s)', async (_name, setup) => {
    setup()
    await checkForUpdates()
    expect(mockHandleManifest).not.toHaveBeenCalled()
    expect(mockHandleCheckFailed).toHaveBeenCalled()
  })

  it('heilt den Altbestand ohne Prüfsumme, wenn die Datei der Beschreibung entspricht', async () => {
    mockSettingsStore.get.mockReturnValue({
      'prod:whisper-large-v3-turbo': { version: 'pre-update', sha256: '', installedAt: '' }
    })
    mockExistsSync.mockReturnValue(true)
    mockVerifyFileSha256.mockResolvedValue(true)
    makeHttpsResponse(200, validManifest)
    await checkForUpdates()
    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'prod:whisper-large-v3-turbo': expect.objectContaining({
          sha256: validManifestModels[0].sha256
        })
      })
    )
  })
})

describe('checkForUpdates — signierte Update-Beschreibung (Issues #163/#164)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifySignature.mockReturnValue(true)
    mockSettingsStore.get.mockReturnValue({})
  })

  it('lädt die Signatur unter dem Hash der Manifest-Bytes', async () => {
    makeHttpsResponse(200, validManifest)
    await checkForUpdates()
    const urls = mockGet.mock.calls.map((c) => c[0] as string)
    expect(urls[0]).toMatch(/manifest\.json$/)
    expect(urls[1]).toMatch(/\/signatures\/[a-f0-9]{64}\.json$/)
    expect(mockVerifySignature).toHaveBeenCalledWith(
      Buffer.from(validManifest),
      expect.anything(),
      expect.anything()
    )
  })

  it('ignoriert ein Manifest mit ungültiger Signatur ganz — keine App- und keine Modell-Updates', async () => {
    mockVerifySignature.mockReturnValue(false)
    makeHttpsResponse(
      200,
      JSON.stringify({
        generatedAt: '2025-01-15T00:00:00Z',
        app: appEntry,
        models: validManifestModels
      })
    )
    await checkForUpdates()
    expect(mockHandleManifest).not.toHaveBeenCalled()
    expect(mockHandleCheckFailed).toHaveBeenCalled()
  })

  it('teilt gleichzeitige Prüfungen in einen Lauf', async () => {
    makeHttpsResponse(200, validManifest)
    await Promise.all([checkForUpdates(), checkForUpdates()])
    expect(mockGet).toHaveBeenCalledTimes(2) // Manifest + Signatur, nicht doppelt
  })
})

describe('cleanupIncompleteUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes .staging/ if it exists', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.staging'))
    mockReaddirSync.mockReturnValue([])

    cleanupIncompleteUpdates()

    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('.staging'), {
      recursive: true
    })
  })

  it('does nothing to .staging/ if it does not exist', () => {
    mockExistsSync.mockReturnValue(false)

    cleanupIncompleteUpdates()

    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('restores backup when model checkPath is missing after crash', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('.staging')) return false
      if (p.endsWith('.backup')) return true
      // checkPath for whisper does not exist
      if (p.includes('ggml-large-v3-turbo')) return false
      return false
    })
    mockReaddirSync.mockReturnValue(['whisper-large-v3-turbo'])

    cleanupIncompleteUpdates()

    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining('whisper-large-v3-turbo'),
      expect.stringContaining('ggml-large-v3-turbo')
    )
  })

  it('deletes orphaned backup when model exists (swap completed)', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('.staging')) return false
      if (p.endsWith('.backup')) return true
      // checkPath for whisper exists
      if (p.includes('ggml-large-v3-turbo')) return true
      return false
    })
    mockReaddirSync.mockImplementation((p: string) => {
      if (p.endsWith('.backup')) return ['whisper-large-v3-turbo']
      return []
    })

    cleanupIncompleteUpdates()

    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('whisper-large-v3-turbo'), {
      recursive: true
    })
    expect(mockRenameSync).not.toHaveBeenCalled()
  })
})

describe('migrateInstalledVersions', () => {
  // Issue #84 Story D — migrateInstalledVersions now writes via the
  // channel-aware adapter. Use a stateful mock that round-trips writes back
  // through reads, so the per-model setInstalledVersion calls accumulate
  // observably (the first call's read sees an empty record, the second
  // sees the first entry, …).
  let storedInstalled: Record<string, unknown> = {}
  beforeEach(() => {
    vi.clearAllMocks()
    storedInstalled = {}
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'installedModelVersions') return storedInstalled
      return null
    })
    mockSettingsStore.set.mockImplementation((key: string, value: unknown) => {
      if (key === 'installedModelVersions') {
        storedInstalled = value as Record<string, unknown>
      }
    })
  })

  it('populates installed versions for existing models', () => {
    mockExistsSync.mockReturnValue(true) // all models exist

    migrateInstalledVersions()

    // Final state contains both models, channel-prefixed (`prod` default).
    expect(storedInstalled).toEqual(
      expect.objectContaining({
        'prod:whisper-large-v3-turbo': expect.objectContaining({
          version: 'pre-update',
          sha256: '' // empty — forces update on first manifest check
        }),
        'prod:pyannote-suite': expect.objectContaining({
          version: 'pre-update',
          sha256: ''
        })
      })
    )
  })

  it('skips models that are not installed on disk', () => {
    // whisper not installed, pyannote installed
    mockExistsSync.mockImplementation(
      (p: string) => p.includes('diarization') || p.includes('speaker-diarization')
    )

    migrateInstalledVersions()

    expect(storedInstalled['prod:pyannote-suite']).toBeDefined()
    expect(storedInstalled['prod:whisper-large-v3-turbo']).toBeUndefined()
  })

  it('does nothing if installedModelVersions already has entries', () => {
    storedInstalled = {
      'prod:whisper-large-v3-turbo': {
        version: '2025-01-15',
        sha256: 'aaaa' + 'a'.repeat(60),
        installedAt: ''
      }
    }

    migrateInstalledVersions()

    expect(mockSettingsStore.set).not.toHaveBeenCalled()
  })

  it('throws clearly if untagged keys are still present (boot-order invariant)', () => {
    // Simulates initSettings's channel-tag migration not having run yet —
    // for example because someone reordered main/index.ts and called
    // migrateInstalledVersions before initSettings. Without this guard the
    // function would silently filter the untagged keys out via the
    // channel-aware adapter, see an empty channel view, and write fresh
    // prod: sentinel rows alongside the legacy ones.
    storedInstalled = {
      'whisper-large-v3-turbo': {
        version: 'pre-update',
        sha256: '',
        installedAt: ''
      }
    }

    expect(() => migrateInstalledVersions()).toThrow(
      /channel-tag migration in initSettings must run first/i
    )
  })
})

describe('isNewerVersion', () => {
  it('detects newer patch version', () => {
    expect(isNewerVersion('0.3.3', '0.3.4')).toBe(true)
  })

  it('detects newer minor version', () => {
    expect(isNewerVersion('0.3.3', '0.4.0')).toBe(true)
  })

  it('detects newer major version', () => {
    expect(isNewerVersion('0.3.3', '1.0.0')).toBe(true)
  })

  it('returns false for same version', () => {
    expect(isNewerVersion('0.3.3', '0.3.3')).toBe(false)
  })

  it('returns false for older version', () => {
    expect(isNewerVersion('0.3.3', '0.2.0')).toBe(false)
  })

  it('returns false when current is newer', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false)
  })
})
