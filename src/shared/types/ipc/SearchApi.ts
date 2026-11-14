import type { RecentSearchQuery, SearchQueryInput, SearchQueryResult } from '../Search'

/**
 * Suche (Epic #192 — #209, #211). PR S4 ergänzt `open`, `semantic`,
 * `retryModel` und `onAvailabilityChanged` in eigenen Zeilen.
 */
export interface SearchApi {
  /** Patientendossiers und exakte Treffer; `semantic` meldet den Stand der Suche nach Bedeutung. */
  query(input: SearchQueryInput): Promise<SearchQueryResult>
  /** Die fünf letzten Suchanfragen, neueste zuerst (#209 AK 27). */
  recentList(): Promise<RecentSearchQuery[]>
  /** Nur aus der Suche über alle Inhalte aufrufen (#211 OOS 3). */
  recentRemember(query: string): Promise<void>
  /** «Verlauf löschen» (#209 AK 28). */
  recentClear(): Promise<void>
}
