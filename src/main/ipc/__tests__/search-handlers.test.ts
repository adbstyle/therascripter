import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { isPackaged: false } }))

import {
  handleSearchQuery,
  handleSearchRecentClear,
  handleSearchRecentList,
  handleSearchRecentRemember,
  handleSearchSemantic,
  SemanticRequestTracker
} from '../search-handlers'

function service() {
  return {
    query: vi.fn((input) => ({
      requestId: input.requestId,
      dossiers: [],
      results: [],
      truncated: false,
      semantic: 'pending' as const
    })),
    semantic: vi.fn(),
    listRecent: vi.fn(() => [{ query: 'a', usedAt: 'x' }]),
    rememberRecent: vi.fn(),
    clearRecent: vi.fn()
  }
}

describe('search IPC handlers', () => {
  it('validates search:query and passes it on', () => {
    const s = service()
    const input = { requestId: 3, query: 'Angst', scope: { kind: 'dossier', dossierId: 'd1' } }
    expect(handleSearchQuery(s, input)).toMatchObject({ requestId: 3, semantic: 'pending' })
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

  it('validates search:semantic and lets a newer request of the same window supersede an older one', async () => {
    const tracker = new SemanticRequestTracker()
    const seen: Array<() => boolean> = []
    const s = {
      semantic: vi.fn(
        async (input: { requestId: number }, opts: { isSuperseded?: () => boolean }) => {
          seen.push(opts.isSuperseded!)
          await new Promise((r) => setTimeout(r, 10))
          return {
            requestId: input.requestId,
            dossiers: [],
            results: [],
            truncated: false,
            semantic: opts.isSuperseded!() ? ('superseded' as const) : ('complete' as const)
          }
        }
      )
    }
    const q = (requestId: number) => ({ requestId, query: 'Angst', scope: { kind: 'all' } })
    const first = handleSearchSemantic(s, tracker, 1, q(1))
    const other = handleSearchSemantic(s, tracker, 2, q(1))
    const second = handleSearchSemantic(s, tracker, 1, q(2))
    expect((await first).semantic).toBe('superseded')
    expect((await second).semantic).toBe('complete')
    expect((await other).semantic).toBe('complete')
    await expect(handleSearchSemantic(s, tracker, 1, { query: '' })).rejects.toThrow(
      /search:semantic/
    )
  })
})
