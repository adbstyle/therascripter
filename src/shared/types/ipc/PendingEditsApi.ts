/** Kanal: Main → Renderer, Payload = Anfrage-ID (string). */
export const FLUSH_PENDING_EDITS_CHANNEL = 'app:flushPendingEdits'
/** Kanal: Renderer → Main, Payload = dieselbe Anfrage-ID nach dem Speichern. */
export const PENDING_EDITS_FLUSHED_CHANNEL = 'app:pendingEditsFlushed'

/**
 * Ausstehende Änderungen beim Beenden der App speichern (Epic #192, Review
 * PR #219). Der Main-Prozess fragt in `before-quit` vor dem Schliessen der
 * Datenbank nach und wartet mit Zeitlimit auf die Bestätigung.
 */
export interface PendingEditsApi {
  /** Meldet den Handler an; nach seinem Ende (auch bei Fehler) wird bestätigt. */
  onFlushRequest(handler: () => Promise<void>): () => void
}
