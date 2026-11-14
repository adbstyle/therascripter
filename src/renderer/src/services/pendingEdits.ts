/**
 * Registry für «ausstehende Änderungen sofort speichern» beim Beenden der App.
 *
 * Der Main-Prozess fragt in `before-quit` — bevor er die Datenbank schliesst
 * oder ein Update tauscht — über `app:flushPendingEdits` nach; die App ruft
 * dann `flushPendingEdits()` und bestätigt (siehe `App.tsx`). Wer Eingaben
 * verzögert speichert (Dossier-Stammdaten, Review-Editor), trägt sich hier ein.
 * Das Schliessen des Fensters beendet die App nicht (rotes Schliessen
 * versteckt es nur) und braucht deshalb keinen Flush.
 */
export type PendingEditsFlusher = () => Promise<void>

const flushers = new Set<PendingEditsFlusher>()

/** Meldet einen Flusher an; liefert die Abmeldung. */
export function registerPendingEditsFlusher(flusher: PendingEditsFlusher): () => void {
  flushers.add(flusher)
  return () => {
    flushers.delete(flusher)
  }
}

/**
 * Ruft alle Flusher auf und wartet auf alle. Fehler einzelner Flusher werden
 * protokolliert und halten die übrigen nie auf.
 */
export async function flushPendingEdits(): Promise<void> {
  const results = await Promise.allSettled([...flushers].map((flush) => flush()))
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[pendingEdits] Speichern beim Beenden fehlgeschlagen:', result.reason)
    }
  }
}
