import { describe, it, expect, beforeEach, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, args?: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, fn)
  },
  app: { getPath: () => '/mock/home' }
}))
vi.mock('../recording-handlers', () => ({ getActiveSessionId: () => null }))

import { registerRecentHandlers } from '../recent-handlers'

describe('recent IPC handlers (#213)', () => {
  const service = { list: vi.fn(() => []), touch: vi.fn() }

  function invoke(channel: string, args?: unknown): unknown {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({}, args)
  }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerRecentHandlers(() => service)
  })

  it('registers recent:list and recent:touch', () => {
    expect([...handlers.keys()].sort()).toEqual(['recent:list', 'recent:touch'])
  })

  it('passes validated targets to the service', () => {
    invoke('recent:list')
    invoke('recent:touch', { kind: 'dossier', id: 'd1' })
    invoke('recent:touch', { kind: 'session', id: 's1' })
    expect(service.list).toHaveBeenCalled()
    expect(service.touch).toHaveBeenNthCalledWith(1, { kind: 'dossier', id: 'd1' })
    expect(service.touch).toHaveBeenNthCalledWith(2, { kind: 'session', id: 's1' })
  })

  it('rejects invalid targets — e.g. an imported PDF has no own kind', () => {
    expect(() => invoke('recent:touch', { kind: 'pdf', id: 'p1' })).toThrow(/IPC recent:touch/)
    expect(() => invoke('recent:touch', { kind: 'session', id: '' })).toThrow()
    expect(() => invoke('recent:touch', { kind: 'session', id: 's1', x: 1 })).toThrow()
    expect(service.touch).not.toHaveBeenCalled()
  })
})
