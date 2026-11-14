import { sendToRenderer } from '../utils/ipc-helpers'
import { MAX_CHANGED_IDS } from '../../shared/validation/change-event-schemas'

/**
 * Änderungs-Events an den Renderer (Epic #192). Statt dass jede Ansicht nach
 * einer eigenen Aktion von Hand neu lädt («refreshTrigger»), meldet der
 * Main-Prozess jede Änderung, die eine Liste betrifft, und die Listen laden
 * selbst nach.
 *
 * Gebündelt per setImmediate: Alle Meldungen eines Ticks (z. B. Statuswechsel
 * plus Titel in einem Handler) gehen als EIN Event hinaus, damit der Renderer
 * nicht mehrfach dieselbe Liste abfragt.
 */

let pendingSessions: Set<string> | null = null

/**
 * Sitzungen haben sich geändert (angelegt, Titel, Status, Zusammenfassung,
 * gelöscht). `deletedIds` nennt endgültig gelöschte Sitzungen — der Renderer
 * entfernt sie damit auch aus dem Verlauf der besuchten Seiten (#213 PC 3).
 */
export function notifySessionsChanged(deletedIds?: string[]): void {
  if (!pendingSessions) {
    pendingSessions = new Set()
    setImmediate(flushSessions)
  }
  for (const id of deletedIds ?? []) pendingSessions.add(id)
}

function flushSessions(): void {
  const ids = [...(pendingSessions ?? [])]
  pendingSessions = null
  // Das Schema begrenzt die Liste — grössere Löschungen gehen in Teilen hinaus
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += MAX_CHANGED_IDS) {
    chunks.push(ids.slice(i, i + MAX_CHANGED_IDS))
  }
  if (chunks.length === 0) chunks.push([])
  for (const deletedIds of chunks) {
    try {
      sendToRenderer('sessions:changed', { deletedIds })
    } catch (error) {
      // Kein Fenster (Start, Tests ohne Electron) — die nächste Abfrage holt alles
      console.warn('[ChangeEvents] sessions:changed nicht zugestellt:', error)
    }
  }
}
