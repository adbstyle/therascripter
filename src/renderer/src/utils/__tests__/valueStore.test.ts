import { describe, it, expect, vi } from 'vitest'
import { createValueStore } from '../valueStore'

describe('createValueStore', () => {
  it('liefert den aktuellen Wert und benachrichtigt Abonnenten bis zur Abmeldung', () => {
    const store = createValueStore(0)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.set(3)
    expect(store.get()).toBe(3)
    expect(listener).toHaveBeenCalledWith(3)

    unsubscribe()
    store.set(4)
    expect(store.get()).toBe(4)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('beliefert die übrigen Abonnenten, wenn einer wirft', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createValueStore(0)
    const after = vi.fn()
    store.subscribe(() => {
      throw new Error('kaputt')
    })
    store.subscribe(after)

    store.set(1)
    expect(after).toHaveBeenCalledWith(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
