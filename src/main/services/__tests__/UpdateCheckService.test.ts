import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockReloadFn = vi.fn()
const mockSendFn = vi.fn()
vi.mock('electron', () => ({
  app: {
    relaunch: vi.fn(),
    quit: vi.fn(),
    getVersion: vi.fn().mockReturnValue('0.3.3'),
    // Default to packaged for tests; the dev-shim test overrides this.
    isPackaged: true
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { reload: mockReloadFn, send: mockSendFn } }])
  }
}))

const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockReaddirSync = vi.fn().mockReturnValue([])
const mockRenameSync = vi.fn()
const mockRmSync = vi.fn()
// Default: reichlich Platz (Disk-Precheck-Tests überschreiben das)
const mockStatfsSync = vi.fn().mockReturnValue({ bavail: 1_000_000_000, bsize: 4096 })

const mockQueueShutdown = vi.fn().mockResolvedValue(undefined)
const mockQueueStart = vi.fn()
vi.mock('../TaskQueueService', () => ({
  getTaskQueue: vi.fn(() => ({
    shutdown: mockQueueShutdown,
    start: mockQueueStart
  }))
}))

vi.mock('fs', () => {
  const fsMock = {
    existsSync: (...a: unknown[]) => mockExistsSync(...a),
    mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
    readdirSync: (...a: unknown[]) => mockReaddirSync(...a),
    renameSync: (...a: unknown[]) => mockRenameSync(...a),
    rmSync: (...a: unknown[]) => mockRmSync(...a),
    statfsSync: (...a: unknown[]) => mockStatfsSync(...a)
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
  // Für den "update only installed"-Filter in checkForUpdates: Die bestehenden Tests
  // simulieren eine Vollinstallation (alle im Manifest gelisteten Modelle sind auf Disk).
  // Per Default true → bestehende Test-Assertions bleiben unverändert.
  isModelInstalled: (id: string) => mockIsModelInstalled(id)
}))

const mockDownloadFile = vi.fn()
const mockVerifyFileSha256 = vi.fn()
const mockExtractTarGz = vi.fn()
vi.mock('../DownloadService', () => ({
  downloadFile: (...a: unknown[]) => mockDownloadFile(...a),
  verifyFileSha256: (...a: unknown[]) => mockVerifyFileSha256(...a),
  extractTarGz: (...a: unknown[]) => mockExtractTarGz(...a)
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
  triggerUpdateRestart,
  cleanupIncompleteUpdates,
  migrateInstalledVersions,
  executeUpdates,
  dismissManifestVersions,
  getAvailableModelUpdates,
  refreshAvailableModelUpdates,
  manifestEntryKey
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
    mockSettingsStore.get.mockReturnValue([manifestEntryKey('a', '1'.repeat(64))])

    dismissManifestVersions([
      { id: 'a', sha256: '1'.repeat(64) }, // duplicate
      { id: 'b', sha256: '2'.repeat(64) }
    ])

    expect(mockSettingsStore.set).toHaveBeenCalledWith('dismissedManifestVersions', [
      manifestEntryKey('a', '1'.repeat(64)),
      manifestEntryKey('b', '2'.repeat(64))
    ])
  })

  it('initializes the list when the existing value is not an array', () => {
    mockSettingsStore.get.mockReturnValue(null)

    dismissManifestVersions([{ id: 'a', sha256: '1'.repeat(64) }])

    expect(mockSettingsStore.set).toHaveBeenCalledWith('dismissedManifestVersions', [
      manifestEntryKey('a', '1'.repeat(64))
    ])
  })
})

describe('verfügbare Modell-Updates — eine Quelle der Wahrheit (Issue #144)', () => {
  const whisperSha = 'cccc' + 'c'.repeat(60)
  const pyannoteSha = 'dddd' + 'd'.repeat(60)
  // Settings mit Gedächtnis: der Stand wird bei jedem Abruf neu berechnet
  let store: Record<string, unknown>

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockIsModelInstalled.mockReturnValue(true)
    store = {
      installedModelVersions: {
        'prod:whisper-large-v3-turbo': { version: 'alt', sha256: 'a'.repeat(64), installedAt: '' },
        'prod:pyannote-suite': { version: 'alt', sha256: 'b'.repeat(64), installedAt: '' }
      },
      dismissedManifestVersions: []
    }
    mockSettingsStore.get.mockImplementation((key: string) => store[key] ?? null)
    mockSettingsStore.set.mockImplementation((key: string, value: unknown) => {
      store[key] = value
    })
  })

  /** Prüfung, bei der whisper und pyannote eine neue Version haben. */
  async function checkWithTwoUpdates(): Promise<void> {
    makeHttpsResponse(
      200,
      JSON.stringify({
        generatedAt: '2026-10-12T00:00:00Z',
        models: [
          { ...JSON.parse(validManifest).models[0], sha256: whisperSha },
          { ...JSON.parse(validManifest).models[1], sha256: pyannoteSha }
        ]
      })
    )
    await checkForUpdates()
  }

  const offered = (): string[] => getAvailableModelUpdates().map((u) => u.id)
  const lastPush = (): string[] => {
    const pushes = mockSendFn.mock.calls.filter(([channel]) => channel === 'modelUpdate:available')
    return (pushes.at(-1)?.[1] as { id: string }[]).map((u) => u.id)
  }

  it('hält das Ergebnis für später mountende Renderer-Stellen bereit und pusht es', async () => {
    await checkWithTwoUpdates()
    expect(offered()).toEqual(['whisper-large-v3-turbo', 'pyannote-suite'])
    expect(lastPush()).toEqual(offered())
  })

  it('pusht auch eine leere Liste, damit veraltete Hinweise verschwinden', async () => {
    await checkWithTwoUpdates()
    store.installedModelVersions = {
      'prod:whisper-large-v3-turbo': { version: 'neu', sha256: whisperSha, installedAt: '' },
      'prod:pyannote-suite': { version: 'neu', sha256: pyannoteSha, installedAt: '' }
    }
    await checkWithTwoUpdates()
    expect(offered()).toEqual([])
    expect(lastPush()).toEqual([])
  })

  it('«Verwerfen» entfernt die Version aus dem Stand und pusht ihn', async () => {
    await checkWithTwoUpdates()
    dismissManifestVersions([{ id: 'whisper-large-v3-turbo', sha256: whisperSha }])
    expect(offered()).toEqual(['pyannote-suite'])
    expect(lastPush()).toEqual(['pyannote-suite'])
  })

  it('behält den Stand, wenn eine Prüfung scheitert', async () => {
    await checkWithTwoUpdates()
    makeHttpsError('Connection refused')
    await checkForUpdates()
    expect(offered()).toHaveLength(2)
  })

  it('bietet kein Update für ein gelöschtes Modell an', async () => {
    await checkWithTwoUpdates()
    mockIsModelInstalled.mockImplementation((id) => id !== 'whisper-large-v3-turbo')
    expect(refreshAvailableModelUpdates().map((u) => u.id)).toEqual(['pyannote-suite'])
    expect(lastPush()).toEqual(['pyannote-suite'])
  })

  it('nimmt jedes eingebaute Update sofort aus dem Angebot — auch wenn ein späteres scheitert', async () => {
    await checkWithTwoUpdates()
    store.pendingModelUpdates = getAvailableModelUpdates()
    mockVerifyFileSha256.mockResolvedValue(true)
    mockDownloadFile
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'HTTP 500' })
    await executeUpdates()
    expect(offered()).toEqual(['pyannote-suite'])
    expect(lastPush()).toEqual(['pyannote-suite'])
  })

  it('eine mit veraltetem Stand gestartete Prüfung meldet eingebaute Updates nicht wieder', async () => {
    await checkWithTwoUpdates()
    // Zwischen Lesen und Ende der Prüfung wird whisper eingebaut
    store.installedModelVersions = {
      ...(store.installedModelVersions as object),
      'prod:whisper-large-v3-turbo': { version: 'neu', sha256: whisperSha, installedAt: '' }
    }
    expect(refreshAvailableModelUpdates().map((u) => u.id)).toEqual(['pyannote-suite'])
  })
})

describe('checkForUpdates — signierte Update-Beschreibung (Issues #163/#164)', () => {
  const appEntry = {
    version: '1.0.0',
    url: 'https://github.com/adbstyle/therascripter/releases/download/v1.0.0/Therascript.dmg',
    sha256: 'd'.repeat(64),
    sizeBytes: 300
  }

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

  it('reicht den App-Eintrag an das App-Update weiter', async () => {
    makeHttpsResponse(
      200,
      JSON.stringify({
        generatedAt: '2025-01-15T00:00:00Z',
        app: appEntry,
        models: validManifestModels
      })
    )
    await checkForUpdates()
    expect(mockHandleManifest).toHaveBeenCalledWith(appEntry)
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
    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toEqual([])
    expect(mockHandleManifest).not.toHaveBeenCalled()
    expect(mockHandleCheckFailed).toHaveBeenCalled()
  })

  it('teilt gleichzeitige Prüfungen in einen Lauf', async () => {
    makeHttpsResponse(200, validManifest)
    await Promise.all([checkForUpdates(), checkForUpdates()])
    expect(mockGet).toHaveBeenCalledTimes(2) // Manifest + Signatur, nicht doppelt
  })

  it('liefert bei Netzwerkfehler keine Updates', async () => {
    makeHttpsError('Connection refused')
    const { modelUpdates } = await checkForUpdates()
    expect(modelUpdates).toEqual([])
    expect(mockHandleManifest).not.toHaveBeenCalled()
    expect(mockHandleCheckFailed).toHaveBeenCalled()
  })
})

describe('triggerUpdateRestart', () => {
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

  beforeEach(async () => {
    mockReloadFn.mockClear()
    const { app } = await import('electron')
    vi.mocked(app.relaunch).mockClear()
    vi.mocked(app.quit).mockClear()
  })

  it('saves pending updates and triggers relaunch in packaged builds', async () => {
    const { app } = await import('electron')
    ;(app as { isPackaged: boolean }).isPackaged = true

    triggerUpdateRestart(updates)

    expect(mockSettingsStore.set).toHaveBeenCalledWith('pendingModelUpdates', updates)
    expect(app.relaunch).toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalled()
    expect(mockReloadFn).not.toHaveBeenCalled()
  })

  it('reloads the renderer in dev mode without quitting (Issue #84 dev-shim)', async () => {
    // Dev-mode: app.relaunch() + app.quit() would kill electron-vite's
    // parent process and orphan a window pointed at a dead localhost:5173.
    // The shim writes pendingModelUpdates and reloads the renderer instead;
    // the next mount of App.tsx reads the pending state and shows
    // ModelUpdateScreen — same observable UX, without the white screen.
    const { app } = await import('electron')
    ;(app as { isPackaged: boolean }).isPackaged = false

    triggerUpdateRestart(updates)

    expect(mockSettingsStore.set).toHaveBeenCalledWith('pendingModelUpdates', updates)
    expect(mockReloadFn).toHaveBeenCalledOnce()
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
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

  it('pausiert die TaskQueue vor dem Swap und startet sie danach wieder', async () => {
    // Ohne Quiescence kann renameSync das ASR-Modell unter einem laufenden
    // whisper-Prozess wegtauschen (Queue resumed recovered Tasks direkt
    // nach dem Relaunch, während executeUpdates noch swappt).
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })

    await executeUpdates()

    expect(mockQueueShutdown).toHaveBeenCalled()
    expect(mockQueueShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      mockRenameSync.mock.invocationCallOrder[0]
    )
    expect(mockQueueStart).toHaveBeenCalled()
  })

  it('startet die TaskQueue auch nach einem Download-Fehler wieder', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })
    mockDownloadFile.mockResolvedValue({ success: false, error: 'HTTP 500' })

    await executeUpdates()

    expect(mockQueueStart).toHaveBeenCalled()
  })

  it('bricht ohne Download ab, wenn der freie Speicherplatz nicht reicht', async () => {
    mockSettingsStore.get.mockImplementation((key: string) => {
      if (key === 'pendingModelUpdates') return [pendingUpdate]
      if (key === 'installedModelVersions') return {}
      return null
    })
    mockStatfsSync.mockReturnValueOnce({ bavail: 0, bsize: 4096 })

    await executeUpdates()

    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockSendFn).toHaveBeenCalledWith(
      'modelUpdate:downloadError',
      expect.stringContaining('Speicherplatz')
    )
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
