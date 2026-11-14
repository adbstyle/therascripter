import type { SearchModelFailureReason } from './types/Search'

/**
 * Deutsche Texte zum Zustand des Suchmodells (#210 AK 4/5) — gemeinsam für
 * Einstellungen → Modelle und das Such-Modal (PR S5).
 */
export const SEARCH_MODEL_FAILURE_TEXT: Record<SearchModelFailureReason, string> = {
  network:
    'Der Download ist gescheitert, weil keine Verbindung zum Download-Server zustande kam. Prüfen Sie die Internetverbindung.',
  'disk-space':
    'Auf dem Mac ist nicht genügend Speicherplatz frei. Das Suchmodell braucht beim Laden rund 1.1 GB.',
  checksum:
    'Die heruntergeladene Datei war beschädigt und wurde verworfen. Beim nächsten Versuch wird sie neu geladen.',
  extract: 'Die heruntergeladene Datei liess sich nicht entpacken.',
  unknown: 'Beim Laden ist ein unerwarteter Fehler aufgetreten.'
}

/** Die Suche ist erst nach dem Laden des Suchmodells verfügbar (#210 AK 4). */
export const SEARCH_MODEL_PENDING_TEXT =
  'Die Suche nach Bedeutung ist verfügbar, sobald das Suchmodell geladen ist. Alles andere in Therascript können Sie schon jetzt nutzen.'

/** Diese Version kennt das Suchmodell, es ist aber noch nicht zum Download freigegeben. */
export const SEARCH_MODEL_UNPUBLISHED_TEXT =
  'Das Suchmodell ist noch nicht verfügbar. Es wird mit einer der nächsten Versionen bereitgestellt.'
