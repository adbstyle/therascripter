import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  beginSearchRequest,
  cancelSearchRequest,
  getSearchEntry,
  isLatestSearchRequest,
  mergeSemanticResult,
  restoreRankedOrder,
  searchEntriesStore,
  searchEntryKey,
  updateSearchEntry,
  type SearchEntryKey,
  type SearchEntryState
} from '../stores/searchSession'
import { SEARCH_MAX_QUERY_LENGTH } from '../../../shared/search-config'
import type {
  SearchAvailability,
  SearchQueryInput,
  SearchScope,
  SemanticSearchStatus
} from '../../../shared/types/Search'

/** Entprellung der Eingabe (Bauplan 7). */
export const SEARCH_DEBOUNCE_MS = 200

/** Stände, in denen die Suche nach Bedeutung für die Antwort nicht lief. */
const UNAVAILABLE: ReadonlySet<SemanticSearchStatus> = new Set([
  'unavailable-processing',
  'model-missing',
  'tool-blocked',
  'error'
])

export function isSemanticUnavailable(status: SemanticSearchStatus | null): boolean {
  return status !== null && UNAVAILABLE.has(status)
}

/** Anfrage, wie sie an den Main-Prozess geht; null = nichts zu suchen. */
export function normalizeQueryInput(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  // Steuerzeichen (z. B. Tabulator aus einer Einfügung) als Leerzeichen
  // eslint-disable-next-line no-control-regex
  const cleaned = trimmed.replace(/[\u0000-\u001F\u007F]+/g, ' ')
  return cleaned.slice(0, SEARCH_MAX_QUERY_LENGTH)
}

export interface UseSearchResult {
  key: SearchEntryKey
  state: SearchEntryState
  /** Stand von Suchmodell und Suche nach Bedeutung; null, solange unbekannt. */
  availability: SearchAvailability | null
  /** Eingabe ändern: sucht entprellt. */
  setQuery: (query: string) => void
  /** Sofort suchen (↵, letzte Suchanfrage), ohne Entprellung. */
  searchNow: (query?: string) => void
  /** Suche nach Bedeutung für die angezeigte Anfrage erneut anstossen. */
  retrySemantic: () => void
  /** «Erneut versuchen» beim Suchmodell (#210 AK 5). */
  retryModel: () => Promise<void>
  update: (patch: Partial<SearchEntryState>) => void
  /** «Nach Relevanz sortieren»: Reihenfolge der letzten Antwort herstellen. */
  sortByRelevance: () => void
}

/**
 * Suche in zwei Stufen (#209, Bauplan 6/7): `search:query` liefert sofort
 * Patientendossiers und exakte Treffer, danach `search:semantic` die mit den
 * Treffern nach Bedeutung gemischte Liste. Jede Anfrage trägt eine
 * `requestId`; Antworten auf überholte Anfragen werden verworfen.
 *
 * `active`: nur ein sichtbares Suchfenster bzw. eine sichtbare Dossier-Suche
 * lädt beim Öffnen vor (`search:open`, #209 AK 16) und folgt der
 * Verfügbarkeit.
 */
export function useSearch(scope: SearchScope, active = true): UseSearchResult {
  const key = searchEntryKey(scope)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const entries = useSyncExternalStore(searchEntriesStore.subscribe, searchEntriesStore.get)
  const state = useMemo(() => entries.get(key) ?? getSearchEntry(key), [entries, key])
  const [availability, setAvailability] = useState<SearchAvailability | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSemantic = useCallback(
    async (input: SearchQueryInput, attempt: number): Promise<void> => {
      try {
        const answer = await window.api.search.semantic(input)
        if (!isLatestSearchRequest(key, input.requestId) || answer.requestId !== input.requestId) {
          return
        }
        if (answer.semantic === 'superseded') {
          // Eine andere Suche desselben Fensters hat diese abgelöst, die eigene
          // ist aber noch aktuell: einmal neu anstossen (nie im Kreis)
          if (attempt === 0) {
            void runSemantic(input, 1)
            return
          }
          updateSearchEntry(key, { semantic: 'error' })
          return
        }
        updateSearchEntry(key, (prev) => ({
          result: prev.result ? mergeSemanticResult(prev.result, answer, prev.interacted) : answer,
          ranked: answer,
          semantic: answer.semantic
        }))
      } catch {
        if (isLatestSearchRequest(key, input.requestId))
          updateSearchEntry(key, { semantic: 'error' })
      }
    },
    [key]
  )

  const run = useCallback(
    async (raw: string): Promise<void> => {
      const query = normalizeQueryInput(raw)
      if (query === null) {
        cancelSearchRequest(key)
        updateSearchEntry(key, {
          submitted: null,
          result: null,
          ranked: null,
          failed: false,
          semantic: null,
          activeKey: null,
          scrollTop: 0,
          interacted: false
        })
        return
      }
      const requestId = beginSearchRequest(key)
      const input: SearchQueryInput = { requestId, query, scope: scopeRef.current }
      try {
        const answer = await window.api.search.query(input)
        if (!isLatestSearchRequest(key, requestId) || answer.requestId !== requestId) return
        // Neue Anfrage: keine Vorauswahl, Liste oben (Abnahme Prototyp)
        updateSearchEntry(key, {
          submitted: query,
          result: answer,
          ranked: answer,
          failed: false,
          semantic: answer.semantic,
          activeKey: null,
          scrollTop: 0,
          interacted: false
        })
        if (answer.semantic === 'pending') await runSemantic(input, 0)
      } catch {
        if (!isLatestSearchRequest(key, requestId)) return
        // Eigener Fehlerzustand mit «Erneut versuchen» — nie «Keine Treffer»
        updateSearchEntry(key, {
          submitted: query,
          result: null,
          ranked: null,
          failed: true,
          semantic: null,
          activeKey: null,
          scrollTop: 0,
          interacted: false
        })
      }
    },
    [key, runSemantic]
  )

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const setQuery = useCallback(
    (query: string) => {
      updateSearchEntry(key, { query })
      clearTimer()
      timer.current = setTimeout(() => {
        timer.current = null
        void run(query)
      }, SEARCH_DEBOUNCE_MS)
    },
    [key, run]
  )

  const searchNow = useCallback(
    (query?: string) => {
      clearTimer()
      const text = query ?? getSearchEntry(key).query
      if (query !== undefined) updateSearchEntry(key, { query })
      // Dieselbe Anfrage ist schon da und vollständig: nicht neu suchen (↵ nach Tippen)
      const current = getSearchEntry(key)
      const normalized = normalizeQueryInput(text)
      if (
        normalized !== null &&
        normalized === current.submitted &&
        current.result !== null &&
        query === undefined
      ) {
        return
      }
      void run(text)
    },
    [key, run]
  )

  const retrySemantic = useCallback(() => {
    const current = getSearchEntry(key)
    // Läuft gerade eine neue Eingabe (Entprellung) oder weicht das Feld von der
    // gezeigten Anfrage ab, gilt die aktuelle Eingabe — nie die alte nachholen
    if (timer.current !== null || normalizeQueryInput(current.query) !== current.submitted) {
      clearTimer()
      void run(current.query)
      return
    }
    if (current.submitted === null) return
    const requestId = beginSearchRequest(key)
    updateSearchEntry(key, { semantic: 'pending' })
    void runSemantic({ requestId, query: current.submitted, scope: scopeRef.current }, 0)
  }, [key, run, runSemantic])

  const retryModel = useCallback(async () => {
    try {
      setAvailability(await window.api.search.retryModel())
    } catch {
      /* Der Zustand kommt über search:availabilityChanged */
    }
  }, [])

  // Vorladen beim Öffnen (#209 AK 16) und der Verfügbarkeit folgen (#210 AK 4/5)
  useEffect(() => {
    if (!active) return
    let alive = true
    window.api.search
      .open()
      .then((a) => {
        if (alive) setAvailability(a)
      })
      .catch(() => {
        /* Ohne Antwort bleibt der Hinweis weg; die exakte Suche geht trotzdem */
      })
    const unsubscribe = window.api.search.onAvailabilityChanged((a) => setAvailability(a))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [active])

  // Beim Öffnen: wurde zuletzt getippt, aber nicht mehr gesucht (Fenster
  // innerhalb der Entprellung geschlossen), jetzt nachholen — sonst passen
  // Feld und Treffer nicht zusammen
  useEffect(() => {
    if (!active) return
    // Erneutes Öffnen: die Reihenfolge der Antwort gilt wieder
    restoreRankedOrder(key)
    const current = getSearchEntry(key)
    if (normalizeQueryInput(current.query) !== current.submitted) void run(current.query)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key])

  // Wird die Suche nach Bedeutung wieder möglich (Verarbeitung fertig, Modell
  // geladen), holt die angezeigte Anfrage sie nach
  const semanticReady = availability?.semantic === 'ready'
  useEffect(() => {
    if (!active || !semanticReady) return
    if (isSemanticUnavailable(getSearchEntry(key).semantic)) retrySemantic()
  }, [active, semanticReady, key, retrySemantic])

  const update = useCallback(
    (patch: Partial<SearchEntryState>) => updateSearchEntry(key, patch),
    [key]
  )

  const sortByRelevance = useCallback(() => restoreRankedOrder(key), [key])

  return {
    key,
    state,
    availability,
    setQuery,
    searchNow,
    retrySemantic,
    retryModel,
    update,
    sortByRelevance
  }
}
