import { describe, it, expect, beforeEach, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, args?: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, fn)
  },
  app: { getPath: () => '/mock/home' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../recording-handlers', () => ({ getActiveSessionId: () => null }))

import { registerDossierHandlers } from '../dossier-handlers'

describe('dossier IPC handlers', () => {
  const service = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    create: vi.fn(() => ({ ok: false, reason: 'duplicate-name', duplicates: [] })),
    update: vi.fn(() => ({ ok: false, reason: 'not-found' })),
    deletePreview: vi.fn(() => null),
    deleteDossier: vi.fn(() => ({ ok: false, reason: 'not-found' }))
  }

  function invoke(channel: string, args?: unknown): unknown {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler({}, args)
  }

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerDossierHandlers(() => service as never)
  })

  it('registers every channel of #204', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'dossier:create',
      'dossier:delete',
      'dossier:deletePreview',
      'dossier:get',
      'dossier:list',
      'dossier:update'
    ])
  })

  it('passes validated payloads to the service', () => {
    invoke('dossier:list')
    invoke('dossier:get', { dossierId: 'd1' })
    invoke('dossier:create', { firstName: 'Anna', lastName: 'Meier', confirmDuplicate: true })
    invoke('dossier:update', { dossierId: 'd1', patch: { note: 'x' } })
    invoke('dossier:deletePreview', { dossierId: 'd1' })
    invoke('dossier:delete', { dossierId: 'd1', fingerprint: 'abc' })

    expect(service.list).toHaveBeenCalled()
    expect(service.get).toHaveBeenCalledWith('d1')
    expect(service.create).toHaveBeenCalledWith({
      firstName: 'Anna',
      lastName: 'Meier',
      confirmDuplicate: true
    })
    expect(service.update).toHaveBeenCalledWith('d1', { note: 'x' })
    expect(service.deletePreview).toHaveBeenCalledWith('d1')
    expect(service.deleteDossier).toHaveBeenCalledWith('d1', 'abc')
  })

  it('rejects invalid payloads before they reach the service', () => {
    expect(() => invoke('dossier:get', {})).toThrow(/IPC dossier:get/)
    expect(() => invoke('dossier:create', { firstName: 'Anna', lastName: ' ' })).toThrow(
      /IPC dossier:create/
    )
    expect(() =>
      invoke('dossier:create', { firstName: 'A', lastName: 'B', birthDate: '2999-01-01' })
    ).toThrow()
    expect(() => invoke('dossier:update', { dossierId: 'd1', patch: {} })).toThrow(
      /IPC dossier:update/
    )
    expect(() => invoke('dossier:delete', { dossierId: 'd1' })).toThrow(/IPC dossier:delete/)
    expect(service.get).not.toHaveBeenCalled()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.deleteDossier).not.toHaveBeenCalled()
  })
})
