import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGet = vi.fn()
const mockSet = vi.fn()
vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: mockGet, set: mockSet })
}))

const mockGetChannel = vi.fn()
vi.mock('../Channel', () => ({
  getChannel: () => mockGetChannel()
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  deleteInstalledVersion,
  getInstalledVersion,
  getInstalledVersions,
  replaceInstalledVersionsForChannel,
  setInstalledVersion
} from '../InstalledVersionsStore'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHA = (c: string): string => c.repeat(64)

const sampleEntry = (sha: string): { version: string; sha256: string; installedAt: string } => ({
  version: '2025-02-01',
  sha256: sha,
  installedAt: '2025-02-01T00:00:00.000Z'
})

beforeEach(() => {
  vi.clearAllMocks()
  mockGetChannel.mockReturnValue('prod')
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('InstalledVersionsStore — Issue #84 Story D', () => {
  it("getInstalledVersions returns only the active channel's entries", () => {
    mockGet.mockReturnValue({
      'prod:whisper-large-v3-turbo': sampleEntry(SHA('a')),
      'staging:whisper-large-v3-turbo': sampleEntry(SHA('b')),
      'local:flair-ner-german-large': sampleEntry(SHA('c'))
    })

    const result = getInstalledVersions()
    expect(Object.keys(result)).toEqual(['whisper-large-v3-turbo'])
    expect(result['whisper-large-v3-turbo'].sha256).toBe(SHA('a'))
  })

  it('getInstalledVersion looks up by plain modelId, scoped to active channel', () => {
    mockGet.mockReturnValue({
      'prod:flair-ner-german-large': sampleEntry(SHA('a')),
      'staging:flair-ner-german-large': sampleEntry(SHA('b'))
    })

    expect(getInstalledVersion('flair-ner-german-large')?.sha256).toBe(SHA('a'))
    expect(getInstalledVersion('unknown-id')).toBeNull()
  })

  it('setInstalledVersion writes the channel-prefixed key without touching other channels', () => {
    mockGet.mockReturnValue({
      'staging:whisper-large-v3-turbo': sampleEntry(SHA('b'))
    })

    setInstalledVersion('whisper-large-v3-turbo', sampleEntry(SHA('a')))

    expect(mockSet).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'prod:whisper-large-v3-turbo': sampleEntry(SHA('a')),
        'staging:whisper-large-v3-turbo': sampleEntry(SHA('b'))
      })
    )
  })

  it("deleteInstalledVersion removes only the active channel's entry", () => {
    mockGet.mockReturnValue({
      'prod:flair-ner-german-large': sampleEntry(SHA('a')),
      'staging:flair-ner-german-large': sampleEntry(SHA('b'))
    })

    deleteInstalledVersion('flair-ner-german-large')

    const written = mockSet.mock.calls[0][1] as Record<string, unknown>
    expect(written).toEqual({
      'staging:flair-ner-german-large': sampleEntry(SHA('b'))
    })
  })

  it('respects a non-prod channel for reads and writes', () => {
    mockGetChannel.mockReturnValue('local')
    mockGet.mockReturnValue({
      'prod:whisper-large-v3-turbo': sampleEntry(SHA('a')),
      'local:whisper-large-v3-turbo': sampleEntry(SHA('z'))
    })

    expect(getInstalledVersion('whisper-large-v3-turbo')?.sha256).toBe(SHA('z'))

    setInstalledVersion('flair-ner-german-large', sampleEntry(SHA('q')))
    expect(mockSet).toHaveBeenCalledWith(
      'installedModelVersions',
      expect.objectContaining({
        'local:flair-ner-german-large': sampleEntry(SHA('q'))
      })
    )
  })

  it('coerces a corrupted top-level value to an empty record', () => {
    mockGet.mockReturnValue(null)
    expect(getInstalledVersions()).toEqual({})

    mockGet.mockReturnValue('garbage')
    expect(getInstalledVersions()).toEqual({})
  })

  it('replaceInstalledVersionsForChannel preserves entries from other channels', () => {
    mockGet.mockReturnValue({
      'prod:old-id-a': sampleEntry(SHA('a')),
      'prod:old-id-b': sampleEntry(SHA('b')),
      'staging:keep-me': sampleEntry(SHA('s'))
    })

    replaceInstalledVersionsForChannel({
      'new-id': sampleEntry(SHA('n'))
    })

    expect(mockSet).toHaveBeenCalledWith('installedModelVersions', {
      'staging:keep-me': sampleEntry(SHA('s')),
      'prod:new-id': sampleEntry(SHA('n'))
    })
  })
})
