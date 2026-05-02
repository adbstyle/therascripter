import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn(), getVersion: vi.fn().mockReturnValue('0.3.3') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) }
}))

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
  // Für den "update only installed"-Filter in checkForUpdates: Die bestehenden Tests
  // simulieren eine Vollinstallation (alle im Manifest gelisteten Modelle sind auf Disk).
  // Per Default true → bestehende Test-Assertions bleiben unverändert.
  isModelInstalled: () => true
}))

const mockDownloadFile = vi.fn()
const mockVerifyFileSha256 = vi.fn()
const mockExtractTarGz = vi.fn()
vi.mock('../DownloadService', () => ({
  downloadFile: (...a: unknown[]) => mockDownloadFile(...a),
  verifyFileSha256: (...a: unknown[]) => mockVerifyFileSha256(...a),
  extractTarGz: (...a: unknown[]) => mockExtractTarGz(...a)
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  checkForUpdates,
  triggerUpdateRestart,
  cleanupIncompleteUpdates,
  migrateInstalledVersions,
  executeUpdates,
  isNewerVersion,
  dismissManifestVersions,
  manifestEntryKey
} from '../UpdateCheckService'

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

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Issue #84 Story D — installedModelVersions keys are now `${channel}:${id}`;
  // default test env yields the `prod` channel.
  it('returns updates when manifest sha256 differs from installed', async () => {
    mockSettingsStore.get.mockReturnValue({
      'prod:whisper-large-v3-turbo': {
        version: '2025-01-15',
        sha256: 'aaaa' + 'a'.repeat(60),
        installedAt: ''
      },
      'prod:pyannote-suite': {
        version: '2025-01-15',
        sha256: 'bbbb' + 'b'.repeat(60),
        installedAt: ''
      }
    })
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()

    expect(modelUpdates).toHaveLength(1)
    expect(modelUpdates[0].id).toBe('whisper-large-v3-turbo')
    expect(modelUpdates[0].sha256).toBe('cccc' + 'c'.repeat(60))
    expect(modelUpdates[0].relativePath).toBe('asr/ggml-large-v3-turbo-q5_0.bin')
    expect(modelUpdates[0].archive).toBe(false)
  })

  it('returns no updates when all sha256 match', async () => {
    mockSettingsStore.get.mockReturnValue({
      'prod:whisper-large-v3-turbo': {
        version: '2025-01-15',
        sha256: 'cccc' + 'c'.repeat(60),
        installedAt: ''
      },
      'prod:pyannote-suite': {
        version: '2025-01-15',
        sha256: 'bbbb' + 'b'.repeat(60),
        installedAt: ''
      }
    })
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('returns all models as updates when no versions installed', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(2)
  })

  it('returns empty modelUpdates on network error (non-blocking)', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsError('Connection refused')

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('returns empty modelUpdates on HTTP 404', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(404, 'Not Found')

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('returns empty modelUpdates on invalid JSON', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, 'not json {{')

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('returns empty modelUpdates on schema validation failure', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, JSON.stringify({ generatedAt: '2025-01-15', models: [] }))

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('skips model with path-traversal in id', async () => {
    mockSettingsStore.get.mockReturnValue({})
    const maliciousManifest = JSON.stringify({
      generatedAt: '2025-01-15',
      models: [
        {
          id: '../../../evil',
          version: '2025-02-01',
          label: 'Evil',
          url: 'https://example.com/evil.bin',
          sha256: 'dddd' + 'd'.repeat(60),
          sizeBytes: 100
        }
      ]
    })
    makeHttpsResponse(200, maliciousManifest)

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })

  it('skips unknown model ids not in MODEL_DEFINITIONS', async () => {
    mockSettingsStore.get.mockReturnValue({})
    const manifest = JSON.stringify({
      generatedAt: '2025-01-15',
      models: [
        {
          id: 'unknown-model-xyz',
          version: '2025-02-01',
          label: 'Unknown',
          url: 'https://example.com/unknown.bin',
          sha256: 'dddd' + 'd'.repeat(60),
          sizeBytes: 100
        }
      ]
    })
    makeHttpsResponse(200, manifest)

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(0)
  })
})

describe('checkForUpdates — dismissed manifest versions (Story F+G)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The settings store is mocked with a single mockReturnValue; for the dismiss
  // filter we need different return values per key, so route by key.
  // Issue #84 Story D — installed entries are passed in plain modelId form
  // for readability; this helper applies the `prod:` channel prefix the
  // adapter expects.
  function setupMockSettings(opts: {
    installed?: Record<string, { version: string; sha256: string; installedAt: string }>
    dismissed?: string[]
  }): void {
    const prefixed: Record<string, { version: string; sha256: string; installedAt: string }> = {}
    for (const [id, val] of Object.entries(opts.installed ?? {})) {
      prefixed[`prod:${id}`] = val
    }
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'installedModelVersions') return prefixed
      if (key === 'dismissedManifestVersions') return opts.dismissed ?? []
      return null
    })
  }

  it('skips a manifest entry whose id+sha256 is in the dismiss list', async () => {
    setupMockSettings({
      installed: {
        'whisper-large-v3-turbo': {
          version: '2025-01-15',
          sha256: 'aaaa' + 'a'.repeat(60),
          installedAt: ''
        },
        'pyannote-suite': {
          version: '2025-01-15',
          sha256: 'bbbb' + 'b'.repeat(60),
          installedAt: ''
        }
      },
      dismissed: [manifestEntryKey('whisper-large-v3-turbo', 'cccc' + 'c'.repeat(60))]
    })
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()
    // whisper would normally be flagged (sha differs) but is dismissed.
    expect(modelUpdates).toHaveLength(0)
  })

  it('still flags a different sha256 for the same id (new manifest revision)', async () => {
    setupMockSettings({
      installed: {
        'whisper-large-v3-turbo': {
          version: '2025-01-15',
          sha256: 'aaaa' + 'a'.repeat(60),
          installedAt: ''
        },
        'pyannote-suite': {
          version: '2025-01-15',
          sha256: 'bbbb' + 'b'.repeat(60),
          installedAt: ''
        }
      },
      // Stale dismiss entry for an older sha256 — manifest now ships 'cccc...'
      // for whisper, so this entry must NOT silence the new update.
      dismissed: [manifestEntryKey('whisper-large-v3-turbo', 'eeee' + 'e'.repeat(60))]
    })
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toHaveLength(1)
    expect(modelUpdates[0].id).toBe('whisper-large-v3-turbo')
  })

  it('tolerates a non-array dismissed value (corrupted setting)', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'installedModelVersions') {
        return {
          'prod:whisper-large-v3-turbo': {
            version: '2025-01-15',
            sha256: 'aaaa' + 'a'.repeat(60),
            installedAt: ''
          },
          'prod:pyannote-suite': {
            version: '2025-01-15',
            sha256: 'bbbb' + 'b'.repeat(60),
            installedAt: ''
          }
        }
      }
      if (key === 'dismissedManifestVersions') return null
      return null
    })
    makeHttpsResponse(200, validManifest)

    const { modelUpdates } = await checkForUpdates()
    // Filter must default to empty set and behave like the baseline check.
    expect(modelUpdates).toHaveLength(1)
  })
})

describe('dismissManifestVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends entries and de-duplicates', () => {
    mockSettingsStore.get.mockReturnValue([
      manifestEntryKey('a', '1'.repeat(64))
    ])

    dismissManifestVersions([
      { id: 'a', sha256: '1'.repeat(64) }, // duplicate
      { id: 'b', sha256: '2'.repeat(64) }
    ])

    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'dismissedManifestVersions',
      [manifestEntryKey('a', '1'.repeat(64)), manifestEntryKey('b', '2'.repeat(64))]
    )
  })

  it('initializes the list when the existing value is not an array', () => {
    mockSettingsStore.get.mockReturnValue(null)

    dismissManifestVersions([{ id: 'a', sha256: '1'.repeat(64) }])

    expect(mockSettingsStore.set).toHaveBeenCalledWith('dismissedManifestVersions', [
      manifestEntryKey('a', '1'.repeat(64))
    ])
  })
})

describe('checkForUpdates — app update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no model updates (all sha256 match)
    mockSettingsStore.get.mockReturnValue({
      'whisper-large-v3-turbo': {
        version: '2025-01-15',
        sha256: 'cccc' + 'c'.repeat(60),
        installedAt: ''
      },
      'pyannote-suite': {
        version: '2025-01-15',
        sha256: 'bbbb' + 'b'.repeat(60),
        installedAt: ''
      }
    })
  })

  it('returns appUpdate.available=true when manifest version is newer', async () => {
    const manifest = JSON.stringify({
      generatedAt: '2025-01-15T00:00:00Z',
      latestAppVersion: '1.0.0',
      models: validManifestModels
    })
    makeHttpsResponse(200, manifest)

    const { appUpdate } = await checkForUpdates()
    expect(appUpdate.available).toBe(true)
    expect(appUpdate.checkedAt).toBeTruthy()
  })

  it('returns appUpdate.available=false when versions match', async () => {
    const manifest = JSON.stringify({
      generatedAt: '2025-01-15T00:00:00Z',
      latestAppVersion: '0.3.3',
      models: validManifestModels
    })
    makeHttpsResponse(200, manifest)

    const { appUpdate } = await checkForUpdates()
    expect(appUpdate.available).toBe(false)
  })

  it('returns appUpdate.available=false when latestAppVersion is absent', async () => {
    makeHttpsResponse(200, validManifest)

    const { appUpdate } = await checkForUpdates()
    expect(appUpdate.available).toBe(false)
    expect(appUpdate.checkedAt).toBeTruthy()
  })

  it('returns appUpdate.available=false when installed is newer than manifest', async () => {
    const manifest = JSON.stringify({
      generatedAt: '2025-01-15T00:00:00Z',
      latestAppVersion: '0.2.0',
      models: validManifestModels
    })
    makeHttpsResponse(200, manifest)

    const { appUpdate } = await checkForUpdates()
    expect(appUpdate.available).toBe(false)
  })

  it('persists cachedAppUpdateStatus to settings', async () => {
    const manifest = JSON.stringify({
      generatedAt: '2025-01-15T00:00:00Z',
      latestAppVersion: '1.0.0',
      models: validManifestModels
    })
    makeHttpsResponse(200, manifest)

    await checkForUpdates()

    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'cachedAppUpdateStatus',
      expect.objectContaining({ available: true })
    )
  })

  it('returns appUpdate.available=false on network error', async () => {
    makeHttpsError('Connection refused')

    const { appUpdate } = await checkForUpdates()
    expect(appUpdate.available).toBe(false)
    expect(appUpdate.checkedAt).toBeNull()
  })
})

describe('triggerUpdateRestart', () => {
  it('saves pending updates and triggers relaunch', async () => {
    const { app } = await import('electron')
    const updates = [
      {
        id: 'whisper-large-v3-turbo',
        version: '2025-02-01',
        label: 'Spracherkennung',
        url: 'https://example.com/whisper.bin',
        sha256: 'cccc' + 'c'.repeat(60),
        sizeBytes: 100,
        relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
        archive: false,
        checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin'
      }
    ]

    triggerUpdateRestart(updates)

    expect(mockSettingsStore.set).toHaveBeenCalledWith('pendingModelUpdates', updates)
    expect(app.relaunch).toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalled()
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

describe('executeUpdates', () => {
  const pendingUpdate = {
    id: 'whisper-large-v3-turbo',
    version: '2025-02-01',
    label: 'Spracherkennung',
    url: 'https://example.com/whisper.bin',
    sha256: 'cccc' + 'c'.repeat(60),
    sizeBytes: 100,
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    archive: false as const,
    checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockDownloadFile.mockResolvedValue({ success: true })
    mockVerifyFileSha256.mockResolvedValue(true)
  })

  it('downloads, verifies, backs up, swaps, and records version for flat file', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })

    await executeUpdates()

    expect(mockDownloadFile).toHaveBeenCalledWith(
      pendingUpdate.url,
      expect.stringContaining('.staging'),
      expect.any(Function)
    )
    expect(mockVerifyFileSha256).toHaveBeenCalledWith(
      expect.stringContaining('.staging'),
      pendingUpdate.sha256
    )
    // Backup: rename final → backup
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining('ggml-large-v3-turbo'),
      expect.stringContaining('.backup')
    )
    // Swap: rename staging → final
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining('.staging'),
      expect.stringContaining('ggml-large-v3-turbo')
    )
    // Record new version (channel-prefixed key per Story D)
    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'prod:whisper-large-v3-turbo': expect.objectContaining({ sha256: pendingUpdate.sha256 })
      })
    )
    // Clear pending
    expect(mockSettingsStore.set).toHaveBeenCalledWith('pendingModelUpdates', null)
  })

  it('extracts tar.gz archive before swapping', async () => {
    const archiveUpdate = {
      ...pendingUpdate,
      id: 'pyannote-suite',
      relativePath: 'diarization',
      archive: true as const,
      checkPath: 'diarization/models--pyannote--speaker-diarization-3.1'
    }
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [archiveUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })
    mockExtractTarGz.mockResolvedValue({ success: true })

    await executeUpdates()

    expect(mockExtractTarGz).toHaveBeenCalledWith(
      expect.stringContaining('.tar.gz'),
      expect.stringContaining('.staging')
    )
  })

  it('aborts and does not clear pending on SHA-256 failure', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })
    mockVerifyFileSha256.mockResolvedValue(false)

    await executeUpdates()

    expect(mockRenameSync).not.toHaveBeenCalled()
    // pendingModelUpdates is NOT cleared
    const clearCalls = mockSettingsStore.set.mock.calls.filter(
      (c: unknown[]) => c[0] === 'pendingModelUpdates' && c[1] === null
    )
    expect(clearCalls).toHaveLength(0)
  })

  it('rolls back to backup when swap fails', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })
    let renameCallCount = 0
    mockRenameSync.mockImplementation(() => {
      renameCallCount++
      if (renameCallCount === 2) {
        // Second rename (staging → final) fails
        throw new Error('EXDEV: cross-device link not permitted')
      }
    })

    await executeUpdates()

    // Rollback: restore backup → final (3rd rename call)
    expect(mockRenameSync).toHaveBeenCalledTimes(3)
  })

  it('does nothing when pendingModelUpdates is null', async () => {
    mockSettingsStore.get.mockReturnValue(null)

    await executeUpdates()

    expect(mockDownloadFile).not.toHaveBeenCalled()
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
