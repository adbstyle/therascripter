import type {
  RecentSearchQuery,
  SearchProcessState,
  SearchQueryInput,
  SearchQueryResult
} from '../Search'

/**
 * Suche (Epic #192 — #209, #211). PR S2 ergänzt `open`, `retryModel` und
 * `onAvailabilityChanged` in eigenen Zeilen.
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
  /**
   * Suche nach Bedeutung samt exakten Treffern, gerankt (PR S4). Nach
   * `query` mit `semantic: 'pending'` aufrufen; eine neuere Anfrage desselben
   * Fensters löst eine ältere ab ('superseded').
   */
  semantic(input: SearchQueryInput): Promise<SearchQueryResult>
  /** Beim Öffnen der Suche: Suchmodell und Vektoren vorladen (#209 AK 16). */
  warmup(): Promise<SearchProcessState>
  /** Zustand des Suchprozesses; gibt die Abmeldung zurück. */
  onProcessStateChanged(callback: (state: SearchProcessState) => void): () => void
}
