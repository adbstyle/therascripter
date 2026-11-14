import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  handleSearchOpen,
  handleSearchRetryModel,
  handleSearchQuery,
  handleSearchRecentClear,
  handleSearchRecentList,
  handleSearchRecentRemember
} from '../search-handlers'

function service() {
  return {
    query: vi.fn((input) => ({
      requestId: input.requestId,
      dossiers: [],
      results: [],
      truncated: false,
      semantic: 'unavailable' as const
    })),
    listRecent: vi.fn(() => [{ query: 'a', usedAt: 'x' }]),
    rememberRecent: vi.fn(),
    clearRecent: vi.fn()
  }
}

describe('search IPC handlers', () => {
  it('validates search:query and passes it on', () => {
    const s = service()
    const input = { requestId: 3, query: 'Angst', scope: { kind: 'dossier', dossierId: 'd1' } }
    expect(handleSearchQuery(s, input)).toMatchObject({ requestId: 3, semantic: 'unavailable' })
    expect(s.query).toHaveBeenCalledWith(input)
  })

  it('rejects empty, too long, control-character and unknown-field payloads', () => {
    const s = service()
    const base = { requestId: 1, scope: { kind: 'all' } }
    for (const bad of [
      { ...base, query: '' },
      { ...base, query: '   ' },
      { ...base, query: 'x'.repeat(201) },
      { ...base, query: 'a\u0000b' },
      { ...base, query: 'a', extra: 1 },
      { ...base, query: 'a', scope: { kind: 'dossier' } },
      { requestId: -1, query: 'a', scope: { kind: 'all' } }
    ]) {
      expect(() => handleSearchQuery(s, bad)).toThrow(/search:query/)
    }
    expect(s.query).not.toHaveBeenCalled()
  })

  it('handles the recent queries', () => {
    const s = service()
    expect(handleSearchRecentList(s)).toEqual([{ query: 'a', usedAt: 'x' }])
    handleSearchRecentRemember(s, { query: 'Angst' })
    expect(s.rememberRecent).toHaveBeenCalledWith('Angst')
    expect(() => handleSearchRecentRemember(s, { query: '' })).toThrow()
    handleSearchRecentClear(s)
    expect(s.clearRecent).toHaveBeenCalled()
  })

  it('search:open und search:retryModel liefern den Stand des Suchmodells (#210 AK 4/5)', async () => {
    const availability = {
      get: vi.fn(() => ({ model: { status: 'downloading' as const, progress: 12 } })),
      retryModel: vi.fn(async () => ({ model: { status: 'ready' as const } }))
    }
    expect(handleSearchOpen(availability)).toEqual({
      model: { status: 'downloading', progress: 12 }
    })
    expect(await handleSearchRetryModel(availability)).toEqual({ model: { status: 'ready' } })
    expect(availability.retryModel).toHaveBeenCalledTimes(1)
  })
})
