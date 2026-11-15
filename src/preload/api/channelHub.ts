import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * Ein `ipcRenderer.on` pro Event-Kanal, die Abonnenten im Renderer über eine
 * eigene Verteilerliste (dritte Sichtprüfung Epic #192). Vorher meldete jede
 * Karte und jedes Popover einen eigenen Listener an — mit gefüllter Liste
 * über Node's Grenze von 10 pro Kanal («MaxListenersExceededWarning: 11
 * dossiers:changed listeners added»), und jedes Ereignis wurde pro Abonnent
 * neu geprüft.
 *
 * Nach aussen bleibt die API gleich: `subscribe(callback)` gibt die Abmeldung
 * zurück. Das Ereignis wird EINMAL geprüft (`parse`); `SKIP` verwirft es (wie
 * vorher ein fehlgeschlagenes `safeParse`). Mit dem ersten Abonnenten
 * meldet sich der Kanal an, mit dem letzten ab — kein hängender Listener.
 * Ein Abonnent, der wirft, hält die übrigen nicht auf.
 */

export const SKIP: unique symbol = Symbol('skip')

interface Subscription<T> {
  callback: (value: T) => void
}

interface Hub {
  subscriptions: Set<Subscription<unknown>>
  handler: (event: IpcRendererEvent, raw: unknown) => void
}

const hubs = new Map<string, Hub>()

export function subscribeChannel<T>(
  channel: string,
  parse: (raw: unknown) => T | typeof SKIP,
  callback: (value: T) => void
): () => void {
  let hub = hubs.get(channel)
  if (!hub) {
    const subscriptions = new Set<Subscription<unknown>>()
    const handler = (_event: IpcRendererEvent, raw: unknown): void => {
      let value: T | typeof SKIP
      try {
        value = parse(raw)
      } catch (error) {
        console.error(`[preload] Ungültiges Ereignis auf ${channel}:`, error)
        return
      }
      if (value === SKIP) return
      // Kopie: ein Abonnent darf sich im Callback ab- oder andere anmelden
      for (const subscription of [...subscriptions]) {
        if (!subscriptions.has(subscription)) continue
        try {
          subscription.callback(value)
        } catch (error) {
          console.error(`[preload] Abonnent von ${channel} fehlgeschlagen:`, error)
        }
      }
    }
    hub = { subscriptions, handler }
    hubs.set(channel, hub)
    ipcRenderer.on(channel, handler)
  }
  // Eigenes Objekt pro Anmeldung: derselbe Callback zweimal angemeldet heisst
  // zweimal benachrichtigt, und jede Abmeldung trifft nur ihre Anmeldung
  const subscription: Subscription<unknown> = { callback: callback as (value: unknown) => void }
  hub.subscriptions.add(subscription)
  const current = hub
  return () => {
    if (!current.subscriptions.delete(subscription)) return
    if (current.subscriptions.size === 0 && hubs.get(channel) === current) {
      hubs.delete(channel)
      ipcRenderer.removeListener(channel, current.handler)
    }
  }
}

/** Nur für Tests: Anzahl Abonnenten eines Kanals (0 = nicht angemeldet). */
export function _subscriberCount(channel: string): number {
  return hubs.get(channel)?.subscriptions.size ?? 0
}
