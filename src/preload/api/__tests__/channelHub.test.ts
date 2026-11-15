// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Ein ipcRenderer.on pro Kanal, Verteilerliste im Preload (dritte
// Sichtprüfung Epic #192: MaxListenersExceededWarning bei gefüllter Liste).

type Handler = (event: unknown, raw: unknown) => void
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, Set<Handler>>()
  return {
    listeners,
    on: vi.fn((channel: string, handler: Handler) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(handler)
    }),
    removeListener: vi.fn((channel: string, handler: Handler) => {
      listeners.get(channel)?.delete(handler)
    }),
    emit(channel: string, raw: unknown): void {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler({}, raw)
    },
    count(channel: string): number {
      return listeners.get(channel)?.size ?? 0
    }
  }
})
vi.mock('electron', () => ({
  ipcRenderer: { on: ipc.on, removeListener: ipc.removeListener, invoke: vi.fn() }
}))

import { _subscriberCount } from '../channelHub'
import { dossierApi } from '../dossiers'
import { recentApi } from '../recent'
import { searchApi } from '../search'

beforeEach(() => {
  ipc.on.mockClear()
  ipc.removeListener.mockClear()
})

describe('channelHub — ein ipcRenderer.on pro Kanal', () => {
  it('50 Abonnenten → genau ein ipcRenderer.on; jedes Ereignis erreicht alle, geprüft einmal', () => {
    const callbacks = Array.from({ length: 50 }, () => vi.fn())
    const offs = callbacks.map((cb) => dossierApi.onChanged(cb))
    expect(ipc.on).toHaveBeenCalledTimes(1)
    expect(ipc.count('dossiers:changed')).toBe(1)
    expect(_subscriberCount('dossiers:changed')).toBe(50)

    ipc.emit('dossiers:changed', { deletedIds: ['d1'] })
    for (const cb of callbacks) expect(cb).toHaveBeenCalledWith({ deletedIds: ['d1'] })
    // Ungültige Daten erreichen niemanden (wie vorher safeParse)
    ipc.emit('dossiers:changed', { deletedIds: 'kaputt' })
    for (const cb of callbacks) expect(cb).toHaveBeenCalledTimes(1)
    for (const off of offs) off()
  })

  it('Abmelden entfernt nur den jeweiligen Abonnenten', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = dossierApi.onChanged(a)
    const offB = dossierApi.onChanged(b)
    offA()
    offA() // idempotent: trifft nicht den anderen
    ipc.emit('dossiers:changed', { deletedIds: [] })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).not.toHaveBeenCalled()
    offB()
  })

  it('derselbe Callback zweimal angemeldet: zwei Anmeldungen, jede Abmeldung trifft ihre', () => {
    const cb = vi.fn()
    const off1 = dossierApi.onChanged(cb)
    const off2 = dossierApi.onChanged(cb)
    ipc.emit('dossiers:changed', { deletedIds: [] })
    expect(cb).toHaveBeenCalledTimes(2)
    off1()
    ipc.emit('dossiers:changed', { deletedIds: [] })
    expect(cb).toHaveBeenCalledTimes(3)
    off2()
  })

  it('nach dem letzten Abmelden kein hängender Listener; ein neuer Abonnent meldet neu an', () => {
    const offs = Array.from({ length: 5 }, () => recentApi.onChanged(vi.fn()))
    expect(ipc.count('recent:changed')).toBe(1)
    for (const off of offs) off()
    expect(ipc.count('recent:changed')).toBe(0)
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(_subscriberCount('recent:changed')).toBe(0)

    const cb = vi.fn()
    const off = recentApi.onChanged(cb)
    expect(ipc.count('recent:changed')).toBe(1)
    ipc.emit('recent:changed', { deletedIds: [] })
    expect(cb).toHaveBeenCalledTimes(1)
    off()
    expect(ipc.count('recent:changed')).toBe(0)
  })

  it('ein werfender Abonnent hält die übrigen nicht auf', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const off1 = searchApi.onAvailabilityChanged(() => {
      throw new Error('kaputt')
    })
    const off2 = searchApi.onAvailabilityChanged(after)
    const availability = { model: { status: 'ready' }, semantic: 'ready' }
    ipc.emit('search:availabilityChanged', availability)
    expect(after).toHaveBeenCalledWith(availability)
    off1()
    off2()
    error.mockRestore()
  })

  it('ein Abonnent, der sich im Callback abmeldet, stört die Verteilung nicht', () => {
    const second = vi.fn()
    const off1: () => void = dossierApi.onChanged(() => off1())
    const off2 = dossierApi.onChanged(second)
    ipc.emit('dossiers:changed', { deletedIds: [] })
    ipc.emit('dossiers:changed', { deletedIds: [] })
    expect(second).toHaveBeenCalledTimes(2)
    off2()
    expect(ipc.count('dossiers:changed')).toBe(0)
  })
})
