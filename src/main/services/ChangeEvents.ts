import { BrowserWindow } from 'electron'
import { MAX_CHANGED_IDS } from '../../shared/validation/change-event-schemas'

/**
 * Änderungs-Events an den Renderer (Epic #192): `sessions:changed` und
 * `dossiers:changed`, Payload `{ deletedIds }`. Statt dass jede Ansicht nach
 * einer eigenen Aktion von Hand neu lädt, meldet der Main-Prozess jede
 * Änderung, die eine Liste betrifft, und die Listen laden selbst nach.
 *
 * Gebündelt per setImmediate: alle Meldungen eines Ticks ergeben pro Kanal
 * genau ein Event, die gelöschten IDs werden vereinigt. Ein Löschen, das viele
 * Sitzungen mitnimmt, löst so keinen Refetch-Sturm aus; mehr als
 * MAX_CHANGED_IDS IDs gehen in Teilen hinaus (Schema-Grenze).
 */

type Channel = 'sessions:changed' | 'dossiers:changed'
type Sender = (channel: Channel, data: { deletedIds: string[] }) => void

/** Ohne Fenster (Start, Tests ohne Electron) wird still nichts gesendet. */
const sendToWindows: Sender = (channel, data) => {
  let windows: BrowserWindow[]
  try {
    windows = BrowserWindow.getAllWindows()
  } catch {
    // Electron nicht verfügbar (Tests mit Teil-Mock) — die nächste Abfrage holt alles
    return
  }
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

const pending = new Map<Channel, Set<string>>()
let scheduled = false
let send: Sender = sendToWindows

function flush(): void {
  scheduled = false
  const batches = [...pending.entries()]
  pending.clear()
  for (const [channel, ids] of batches) {
    const all = [...ids]
    if (all.length === 0) {
      send(channel, { deletedIds: [] })
      continue
    }
    for (let i = 0; i < all.length; i += MAX_CHANGED_IDS) {
      send(channel, { deletedIds: all.slice(i, i + MAX_CHANGED_IDS) })
    }
  }
}

function enqueue(channel: Channel, deletedIds: readonly string[]): void {
  let ids = pending.get(channel)
  if (!ids) {
    ids = new Set()
    pending.set(channel, ids)
  }
  for (const id of deletedIds) ids.add(id)
  if (!scheduled) {
    scheduled = true
    setImmediate(flush)
  }
}

/**
 * Sitzungen haben sich geändert (angelegt, Titel, Status, Zusammenfassung,
 * gelöscht). `deletedIds` nennt gelöschte Sitzungen — der Renderer entfernt
 * sie damit auch aus dem Verlauf der besuchten Seiten (#213 PC 3).
 */
export function notifySessionsChanged(deletedIds: readonly string[] = []): void {
  enqueue('sessions:changed', deletedIds)
}

/** Patientendossiers haben sich geändert; `deletedIds` nennt gelöschte. */
export function notifyDossiersChanged(deletedIds: readonly string[] = []): void {
  enqueue('dossiers:changed', deletedIds)
}

/** Nur für Tests: Empfänger ersetzen (null = Fenster). */
export function setChangeEventSenderForTests(sender: Sender | null): void {
  send = sender ?? sendToWindows
}
