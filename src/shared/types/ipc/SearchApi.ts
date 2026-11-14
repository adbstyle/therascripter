import type {
  RecentSearchQuery,
  SearchAvailability,
  SearchQueryInput,
  SearchQueryResult
} from '../Search'

/**
 * Suche (Epic #192 — #209, #210, #211). PR S4 ergänzt `semantic` in einer
 * eigenen Zeile.
 */
export interface SearchApi {
  /**
   * Beim Öffnen der Suche: Stand des Suchmodells (#210 AK 4/5). PR S4 lädt
   * hier zusätzlich das Modell vor (#209 AK 16).
   */
  open(): Promise<SearchAvailability>
  /** «Erneut versuchen», wenn das Suchmodell nicht geladen werden konnte (#210 AK 5). */
  retryModel(): Promise<SearchAvailability>
  /** Verfügbarkeit hat sich geändert (z. B. Download-Fortschritt). Gibt die Abmeldung zurück. */
  onAvailabilityChanged(callback: (availability: SearchAvailability) => void): () => void
  /** Patientendossiers und exakte Treffer; `semantic` meldet den Stand der Suche nach Bedeutung. */
  query(input: SearchQueryInput): Promise<SearchQueryResult>
  /** Die fünf letzten Suchanfragen, neueste zuerst (#209 AK 27). */
  recentList(): Promise<RecentSearchQuery[]>
  /** Nur aus der Suche über alle Inhalte aufrufen (#211 OOS 3). */
  recentRemember(query: string): Promise<void>
  /** «Verlauf löschen» (#209 AK 28). */
  recentClear(): Promise<void>
}
