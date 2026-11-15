import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * Ein `ipcRenderer.on` pro Event-Kanal, die Abonnenten im Renderer über eine
 * eigene Verteilerliste (dritte Sichtprüfung Epic #192). Vorher meldete jede
 * Karte und jedes Popover einen eigenen Listener an — mit gefüllter Liste
 * über Node's Grenze von 10 pro Kanal («MaxListenersExceededWarning: 11
 * dossiers:changed listeners added»), und jedes Ereignis wurde pro Abonnent
 * neu geprüft.
 *
 * Nach aussen bleibt die API gleich: `onChanged(callback)` gibt die Abmeldung
 * zurück. Das Ereignis wird EINMAL geprüft (`parse`, pro Kanal einmal beim
 * Laden des Moduls festgelegt); `SKIP` verwirft es (wie
 * vorher ein fehlgeschlagenes `safeParse`). Mit dem ersten Abonnenten
 * meldet sich der Kanal an, mit dem letzten ab — kein hängender Listener.
 * Ein Abonnent, der wirft, hält die übrigen nicht auf.
 */

export const SKIP: unique symbol = Symbol('skip')

interface Subscription<T> {
  callback: (value: T) => void
}

interface Channel<T> {
  parse: (raw: unknown) => T | typeof SKIP
  subscriptions: Set<Subscription<T>>
  handler: ((event: IpcRendererEvent, raw: unknown) => void) | null
}

const channels = new Map<string, Channel<unknown>>()

/**
 * Legt einen Kanal mit seiner Prüfung fest — einmal, beim Laden des Moduls
 * (Review PR #234: nicht «die Prüfung des ersten Abonnenten»). Abonnenten
 * geben nur noch ihren Callback; die Prüfung kann keiner ändern. Ein zweites
 * `createChannel` für denselben Kanal ist ein Programmierfehler und wirft.
 * Gibt `subscribe(callback) => unsubscribe` zurück.
 */
export function createChannel<T>(
  name: string,
  parse: (raw: unknown) => T | typeof SKIP
): (callback: (value: T) => void) => () => void {
  if (channels.has(name)) throw new Error(`Kanal ${name} ist bereits festgelegt`)
  const channel: Channel<T> = { parse, subscriptions: new Set(), handler: null }
  channels.set(name, channel as Channel<unknown>)

  const dispatch = (_event: IpcRendererEvent, raw: unknown): void => {
    let value: T | typeof SKIP
    try {
      value = channel.parse(raw)
    } catch (error) {
      console.error(`[preload] Ungültiges Ereignis auf ${name}:`, error)
      return
    }
    if (value === SKIP) return
    // Kopie: ein Abonnent darf sich im Callback ab- oder andere anmelden
    for (const subscription of [...channel.subscriptions]) {
      if (!channel.subscriptions.has(subscription)) continue
      try {
        subscription.callback(value)
      } catch (error) {
        console.error(`[preload] Abonnent von ${name} fehlgeschlagen:`, error)
      }
    }
  }

  return (callback) => {
    if (!channel.handler) {
      channel.handler = dispatch
      ipcRenderer.on(name, dispatch)
    }
    // Eigenes Objekt pro Anmeldung: derselbe Callback zweimal angemeldet heisst
    // zweimal benachrichtigt, und jede Abmeldung trifft nur ihre Anmeldung
    const subscription: Subscription<T> = { callback }
    channel.subscriptions.add(subscription)
    return () => {
      if (!channel.subscriptions.delete(subscription)) return
      if (channel.subscriptions.size === 0 && channel.handler) {
        ipcRenderer.removeListener(name, channel.handler)
        channel.handler = null
      }
    }
  }
}

/** Nur für Tests: Anzahl Abonnenten eines Kanals (0 = nicht angemeldet). */
export function _subscriberCount(name: string): number {
  return channels.get(name)?.subscriptions.size ?? 0
}
