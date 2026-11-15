import type { SearchModelState } from '../../../shared/types/Search'
import {
  SEARCH_MODEL_FAILURE_TEXT,
  SEARCH_MODEL_PENDING_TEXT,
  SEARCH_MODEL_UNPUBLISHED_TEXT,
  SEARCH_MODEL_WAIT_TEXT
} from '../../../shared/search-model-texts'

/**
 * Texte zum Zustand des Suchmodells (#210 AK 4/5) — eine Stelle für die
 * Statuskarte in Einstellungen → Modelle und die Hinweise der Suche.
 */

/** Uhrzeit des nächsten Versuchs, z. B. «14:05». */
export function formatAttemptTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}

/** Kurzer Status für die angesagte Zeile — ändert sich nur beim Zustandswechsel. */
export function searchModelStatusLabel(state: SearchModelState): string {
  switch (state.status) {
    case 'ready':
      return 'Bereit'
    case 'waiting':
      return 'Wartet'
    case 'downloading':
      return 'Wird geladen'
    case 'retry-scheduled':
      return `Nächster Versuch um ${formatAttemptTime(state.nextAttemptAt)}`
    case 'failed':
      return 'Laden fehlgeschlagen'
    case 'unpublished':
      return 'Noch nicht verfügbar'
  }
}

/** Beschreibung des Zustands; Fehler nennen ihren Grund (#210 AK 5). */
export function describeSearchModel(state: SearchModelState): string {
  switch (state.status) {
    case 'ready':
      return 'Liegt auf Ihrem Mac. Die Suche nach Bedeutung ist verfügbar.'
    case 'waiting':
      return state.reason === 'busy' && state.nextAttemptAt
        ? `${SEARCH_MODEL_WAIT_TEXT.busy} Nächste Prüfung um ${formatAttemptTime(state.nextAttemptAt)}.`
        : SEARCH_MODEL_WAIT_TEXT[state.reason]
    case 'downloading':
      return SEARCH_MODEL_PENDING_TEXT
    case 'retry-scheduled':
      return `${SEARCH_MODEL_FAILURE_TEXT[state.reason]} Therascript versucht es von selbst erneut.`
    case 'failed':
      return `${SEARCH_MODEL_FAILURE_TEXT[state.reason]} Therascript versucht es weiterhin alle 6 Stunden von selbst.`
    case 'unpublished':
      return SEARCH_MODEL_UNPUBLISHED_TEXT
  }
}
