import { createValueStore } from '../utils/valueStore'
import { isModalDialogOpen } from '../navigation/navigation'
import type {
  SearchDocumentResult,
  SearchQueryResult,
  SearchScope,
  SemanticSearchStatus
} from '../../../shared/types/Search'

/**
 * Zustand der Suche im Speicher (#209 AK 12, #211 AK 4): Anfrage, Treffer,
 * Auswahl und Scroll-Position — einmal für die Suche über alle Inhalte (das
 * Suchfenster) und je Patientendossier für die Suche im Dossier. Lebt nur im
 * Renderer-Speicher: nach einem Neustart beginnt die Suche leer; nichts davon
 * geht auf die Platte oder in ein Protokoll.
 *
 * Bleibt, bis erneut gesucht wird; gelöschte Sitzungen und Dossiers
 * verschwinden über `purgeDeletedSessions` / `purgeDeletedDossiers` aus den
 * gemerkten Treffern.
 */

export interface SearchEntryState {
  /** Text im Eingabefeld. */
  query: string
  /** Anfrage, zu der `result` gehört; null = noch nichts gesucht bzw. leer. */
  submitted: string | null
  /** Angezeigte Treffer (exakt sofort, nach Bedeutung gemischt, sobald da). */
  result: SearchQueryResult | null
  /**
   * Stand der Suche nach Bedeutung für `result`: 'pending' solange sie läuft,
   * danach die Antwort aus `search:semantic` bzw. der Grund aus `search:query`.
   */
  semantic: SemanticSearchStatus | null
  /** Ausgewählter Eintrag der Liste (Schlüssel aus `searchOptions`); null = keiner. */
  activeKey: string | null
  /** Scroll-Position der Trefferliste. */
  scrollTop: number
  /**
   * Der USER hat mit der Liste gearbeitet (Pfeiltasten, Maus, Scrollen,
   * Treffer geöffnet): nachkommende Treffer nach Bedeutung werden dann unten
   * angehängt, statt die Liste unter ihm umzusortieren.
   */
  interacted: boolean
}

export const EMPTY_SEARCH_ENTRY: SearchEntryState = {
  query: '',
  submitted: null,
  result: null,
  semantic: null,
  activeKey: null,
  scrollTop: 0,
  interacted: false
}

export type SearchEntryKey = 'all' | `dossier:${string}`

export function searchEntryKey(scope: SearchScope): SearchEntryKey {
  return scope.kind === 'all' ? 'all' : `dossier:${scope.dossierId}`
}

const entries = createValueStore<ReadonlyMap<SearchEntryKey, SearchEntryState>>(new Map())

export const searchEntriesStore = entries

export function getSearchEntry(key: SearchEntryKey): SearchEntryState {
  return entries.get().get(key) ?? EMPTY_SEARCH_ENTRY
}

export function updateSearchEntry(
  key: SearchEntryKey,
  patch: Partial<SearchEntryState> | ((prev: SearchEntryState) => Partial<SearchEntryState>)
): void {
  const prev = getSearchEntry(key)
  const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
  const map = new Map(entries.get())
  map.set(key, next)
  entries.set(map)
}

/** Fortlaufende Anfrage-Nummern für alle Suchen dieses Fensters. */
let lastRequestId = 0
const latestRequest = new Map<SearchEntryKey, number>()

export function beginSearchRequest(key: SearchEntryKey): number {
  lastRequestId += 1
  latestRequest.set(key, lastRequestId)
  return lastRequestId
}

/** Ist das noch die neueste Anfrage dieser Suche? Ältere Antworten werden verworfen. */
export function isLatestSearchRequest(key: SearchEntryKey, requestId: number): boolean {
  return latestRequest.get(key) === requestId
}

/** Laufende Anfrage dieser Suche verwerfen (Feld geleert). */
export function cancelSearchRequest(key: SearchEntryKey): void {
  latestRequest.delete(key)
}

function withoutSessions(
  result: SearchQueryResult | null,
  deleted: ReadonlySet<string>
): SearchQueryResult | null {
  if (!result) return result
  const results = result.results.filter((doc) => !deleted.has(doc.sessionId))
  if (results.length === result.results.length) return result
  return { ...result, results }
}

/** Gelöschte Sitzungen und PDF-Dokumente verschwinden aus allen gemerkten Treffern. */
export function purgeDeletedSessions(deletedIds: readonly string[]): void {
  if (deletedIds.length === 0) return
  const deleted = new Set(deletedIds)
  let changed = false
  const map = new Map<SearchEntryKey, SearchEntryState>()
  for (const [key, entry] of entries.get()) {
    const result = withoutSessions(entry.result, deleted)
    if (result !== entry.result) changed = true
    map.set(key, result === entry.result ? entry : { ...entry, result })
  }
  if (changed) entries.set(map)
}

function withoutDossierRefs(doc: SearchDocumentResult, deleted: ReadonlySet<string>) {
  const dossiers = doc.dossiers.filter((d) => !deleted.has(d.id))
  return dossiers.length === doc.dossiers.length ? doc : { ...doc, dossiers }
}

/**
 * Gelöschte Patientendossiers: ihre Dossier-Suche endet (#211 AK 4), sie
 * verschwinden aus den Dossier-Treffern und aus den Plaketten der Inhalte.
 */
export function purgeDeletedDossiers(deletedIds: readonly string[]): void {
  if (deletedIds.length === 0) return
  const deleted = new Set(deletedIds)
  let changed = false
  const map = new Map<SearchEntryKey, SearchEntryState>()
  for (const [key, entry] of entries.get()) {
    if (key.startsWith('dossier:') && deleted.has(key.slice('dossier:'.length))) {
      changed = true
      continue
    }
    const result = entry.result
    if (!result) {
      map.set(key, entry)
      continue
    }
    const dossiers = result.dossiers.filter((d) => !deleted.has(d.id))
    const results = result.results.map((doc) => withoutDossierRefs(doc, deleted))
    const same =
      dossiers.length === result.dossiers.length && results.every((d, i) => d === result.results[i])
    if (same) {
      map.set(key, entry)
      continue
    }
    changed = true
    map.set(key, { ...entry, result: { ...result, dossiers, results } })
  }
  if (changed) entries.set(map)
}

/**
 * Treffer nach Bedeutung kommen nach (#209, Bauplan 6): hat der USER schon
 * mit der Liste gearbeitet, bleiben die angezeigten Dokumente an ihrer Stelle
 * und neue kommen unten dazu — die Liste springt nicht unter Maus oder
 * Auswahl weg. Sonst gilt die gerankte Reihenfolge der zweiten Antwort.
 */
export function mergeSemanticResult(
  shown: SearchQueryResult,
  next: SearchQueryResult,
  keepOrder: boolean
): SearchQueryResult {
  if (!keepOrder) return next
  const known = new Set(shown.results.map((d) => d.sessionId))
  const added = next.results.filter((d) => !known.has(d.sessionId))
  return {
    ...next,
    dossiers: shown.dossiers,
    results: [...shown.results, ...added]
  }
}

/** Suchfenster (⌘K) offen? Eine Stelle für Menü, Seitenleiste und Rücksprung. */
export const searchModalOpen = createValueStore(false)

/** Element, das vor dem Öffnen den Fokus hatte. */
let returnFocus: Element | null = null

/** Suchfenster öffnen — Seitenleiste «Suchen», Menü «Gehe zu → Suchen …» (⌘K). */
export function openSearchModal(): void {
  // Nie über einem anderen Dialog (Löschen, Sperrliste …)
  if (searchModalOpen.get() || isModalDialogOpen()) return
  returnFocus = document.activeElement
  searchModalOpen.set(true)
}

/**
 * Suchfenster schliessen. Der Fokus geht dorthin zurück, wo er vorher war —
 * nicht nach dem Öffnen eines Treffers (`navigate`), dann gehört er der neuen Seite.
 */
export function closeSearchModal(reason?: 'navigate'): void {
  if (!searchModalOpen.get()) return
  searchModalOpen.set(false)
  const previous = returnFocus
  returnFocus = null
  if (reason !== 'navigate' && previous instanceof HTMLElement && previous.isConnected) {
    previous.focus()
  }
}

/** Nur für Tests. */
export function _resetSearchSessionForTests(): void {
  entries.set(new Map())
  latestRequest.clear()
  searchModalOpen.set(false)
  returnFocus = null
}
