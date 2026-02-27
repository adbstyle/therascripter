import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), quit: vi.fn() },
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
      id: 'pyannote-community-1',
      label: 'Sprechererkennung',
      url: 'https://example.com/pyannote.tar.gz',
      sha256: 'bbbb' + 'b'.repeat(60),
      relativePath: 'diarization',
      checkPath: 'diarization/models--pyannote--speaker-diarization-3.1',
      sizeBytes: 200,
      archive: true
    }
  ]
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
  executeUpdates
} from '../ModelUpdateService'

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

const validManifest = JSON.stringify({
  generatedAt: '2025-01-15T00:00:00Z',
  models: [
    {
      id: 'whisper-large-v3-turbo',
      version: '2025-02-01',
      label: 'Spracherkennung',
      url: 'https://example.com/whisper.bin',
      sha256: 'cccc' + 'c'.repeat(60), // different from installed aaaa...
      sizeBytes: 100
    },
    {
      id: 'pyannote-community-1',
      version: '2025-02-01',
      label: 'Sprechererkennung',
      url: 'https://example.com/pyannote.tar.gz',
      sha256: 'bbbb' + 'b'.repeat(60), // same as installed — no update
      sizeBytes: 200
    }
  ]
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns updates when manifest sha256 differs from installed', async () => {
    mockSettingsStore.get.mockReturnValue({
      'whisper-large-v3-turbo': { version: '2025-01-15', sha256: 'aaaa' + 'a'.repeat(60), installedAt: '' },
      'pyannote-community-1': { version: '2025-01-15', sha256: 'bbbb' + 'b'.repeat(60), installedAt: '' }
    })
    makeHttpsResponse(200, validManifest)

    const updates = await checkForUpdates()

    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('whisper-large-v3-turbo')
    expect(updates[0].sha256).toBe('cccc' + 'c'.repeat(60))
    expect(updates[0].relativePath).toBe('asr/ggml-large-v3-turbo-q5_0.bin')
    expect(updates[0].archive).toBe(false)
  })

  it('returns no updates when all sha256 match', async () => {
    mockSettingsStore.get.mockReturnValue({
      'whisper-large-v3-turbo': { version: '2025-01-15', sha256: 'cccc' + 'c'.repeat(60), installedAt: '' },
      'pyannote-community-1': { version: '2025-01-15', sha256: 'bbbb' + 'b'.repeat(60), installedAt: '' }
    })
    makeHttpsResponse(200, validManifest)

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
  })

  it('returns all models as updates when no versions installed', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, validManifest)

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(2)
  })

  it('returns empty array on network error (non-blocking)', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsError('Connection refused')

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
  })

  it('returns empty array on HTTP 404', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(404, 'Not Found')

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
  })

  it('returns empty array on invalid JSON', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, 'not json {{')

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
  })

  it('returns empty array on schema validation failure', async () => {
    mockSettingsStore.get.mockReturnValue({})
    makeHttpsResponse(200, JSON.stringify({ generatedAt: '2025-01-15', models: [] }))

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
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

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
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

    const updates = await checkForUpdates()
    expect(updates).toHaveLength(0)
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

    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('.staging'),
      { recursive: true }
    )
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

    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('whisper-large-v3-turbo'),
      { recursive: true }
    )
    expect(mockRenameSync).not.toHaveBeenCalled()
  })
})

describe('migrateInstalledVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('populates installed versions for existing models', () => {
    mockSettingsStore.get.mockReturnValue({})
    mockExistsSync.mockReturnValue(true) // all models exist

    migrateInstalledVersions()

    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'whisper-large-v3-turbo': expect.objectContaining({
          version: 'pre-update',
          sha256: '' // empty — forces update on first manifest check
        }),
        'pyannote-community-1': expect.objectContaining({
          version: 'pre-update',
          sha256: '' // empty — forces update on first manifest check
        })
      })
    )
  })

  it('skips models that are not installed on disk', () => {
    mockSettingsStore.get.mockReturnValue({})
    // whisper not installed, pyannote installed
    mockExistsSync.mockImplementation((p: string) =>
      p.includes('diarization') || p.includes('speaker-diarization')
    )

    migrateInstalledVersions()

    const call = mockSettingsStore.set.mock.calls[0]
    const versions = call[1] as Record<string, unknown>
    expect(versions['pyannote-community-1']).toBeDefined()
    expect(versions['whisper-large-v3-turbo']).toBeUndefined()
  })

  it('does nothing if installedModelVersions already has entries', () => {
    mockSettingsStore.get.mockReturnValue({
      'whisper-large-v3-turbo': { version: '2025-01-15', sha256: 'aaaa' + 'a'.repeat(60), installedAt: '' }
    })

    migrateInstalledVersions()

    expect(mockSettingsStore.set).not.toHaveBeenCalled()
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
    // Record new version
    expect(mockSettingsStore.set).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'whisper-large-v3-turbo': expect.objectContaining({ sha256: pendingUpdate.sha256 })
      })
    )
    // Clear pending
    expect(mockSettingsStore.set).toHaveBeenCalledWith('pendingModelUpdates', null)
  })

  it('extracts tar.gz archive before swapping', async () => {
    const archiveUpdate = {
      ...pendingUpdate,
      id: 'pyannote-community-1',
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
