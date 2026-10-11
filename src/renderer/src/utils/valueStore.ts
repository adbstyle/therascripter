export type ValueListener<T> = (value: T) => void

/**
 * Lesbarer Wert mit Abonnement — für hochfrequente Live-Werte, die nicht durch
 * den React-State eines Elternteils laufen sollen (Issue #140). Kompatibel mit
 * `useSyncExternalStore(store.subscribe, store.get)`; `subscribe` und `get`
 * sind stabile Referenzen.
 */
export interface ValueStore<T> {
  get: () => T
  subscribe: (listener: ValueListener<T>) => () => void
}

export interface WritableValueStore<T> extends ValueStore<T> {
  set: (value: T) => void
}

export function createValueStore<T>(initial: T): WritableValueStore<T> {
  let current = initial
  const listeners = new Set<ValueListener<T>>()

  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (value) => {
      current = value
      // Ein werfender Listener darf die übrigen nicht vom Wert abschneiden.
      for (const listener of listeners) {
        try {
          listener(value)
        } catch (err) {
          console.error('ValueStore-Listener fehlgeschlagen:', err)
        }
      }
    }
  }
}
