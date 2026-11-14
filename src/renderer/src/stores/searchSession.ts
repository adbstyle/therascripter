import { createValueStore } from '../utils/valueStore'
import { isModalDialogOpen } from '../navigation/navigation'
import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import type { DossierRef } from '../../../shared/types/Dossier'
import type {
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
   * Die letzte Antwort in ihrer gerankten Reihenfolge. Weicht `result` davon ab
   * (der USER hat schon mit der Liste gearbeitet, als die Treffer nach Bedeutung
   * kamen), stellt «Nach Relevanz sortieren» sie her.
   */
  ranked: SearchQueryResult | null
  /** Die exakte Suche selbst ist gescheitert (kein «Keine Treffer»). */
  failed: boolean
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
   * Der USER hat mit der Liste gearbeitet (Pfeiltasten, eigenes Scrollen,
   * Klick): nachkommende Treffer nach Bedeutung behalten dann die Positionen
   * der angezeigten Dokumente, neue kommen unten dazu. Eine Maus, die nur über
   * der Liste liegt, zählt nicht.
   */
  interacted: boolean
}

export const EMPTY_SEARCH_ENTRY: SearchEntryState = {
  query: '',
  submitted: null,
  result: null,
  ranked: null,
  failed: false,
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
  if (next.result !== prev.result) rememberDossiersOf(next.result)
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
    const ranked = withoutSessions(entry.ranked, deleted)
    if (result !== entry.result || ranked !== entry.ranked) changed = true
    map.set(
      key,
      result === entry.result && ranked === entry.ranked ? entry : { ...entry, result, ranked }
    )
  }
  if (changed) entries.set(map)
}

/**
 * Dossiers, die in angezeigten Treffern vorkamen (als Treffer oder Plakette) —
 * nur im Speicher, damit nach dem Löschen eines Dossiers auch Anfragen mit
 * seinem Namen verworfen werden können (`dossiers:changed` trägt nur IDs).
 */
const seenDossiers = new Map<string, DossierRef>()

/** Merkt sich die Dossiers einer angezeigten Antwort. */
export function rememberDossiersOf(result: SearchQueryResult | null): void {
  if (!result) return
  for (const d of result.dossiers) seenDossiers.set(d.id, d)
  for (const doc of result.results) for (const d of doc.dossiers) seenDossiers.set(d.id, d)
}

function resultMentions(result: SearchQueryResult | null, deleted: ReadonlySet<string>): boolean {
  if (!result) return false
  return (
    result.dossiers.some((d) => deleted.has(d.id)) ||
    result.results.some((doc) => doc.dossiers.some((d) => deleted.has(d.id)))
  )
}

/** Normalisierte Schlüssel eines Dossiers wie bei #209 PC 4 (Vorname, Nachname, ID). */
function dossierKeys(ref: DossierRef): string[] {
  return [ref.firstName, ref.lastName, ref.externalId ?? '']
    .map((v) => normalizeSearchText(v).trim())
    .filter((v) => v.length > 0)
}

function queryMentions(entry: SearchEntryState, keys: string[]): boolean {
  if (keys.length === 0) return false
  return [entry.query, entry.submitted ?? ''].some((q) => {
    const norm = normalizeSearchText(q)
    return keys.some((k) => norm.includes(k))
  })
}

/**
 * Gelöschte Patientendossiers (Datenschutz, gleiche Regel wie #209 PC 4):
 * jeder gemerkte Zustand — auch die Suche über alle Inhalte — beginnt leer,
 * wenn sein Ergebnis eines der Dossiers enthielt oder seine Anfrage dessen
 * Vor-, Nachnamen oder ID enthält; die Dossier-Suche des Dossiers endet
 * (#211 AK 4). Sonst blieben Anfrage und Klartext-Ausschnitte bis zum Neustart.
 */
export function purgeDeletedDossiers(deletedIds: readonly string[]): void {
  if (deletedIds.length === 0) return
  const deleted = new Set(deletedIds)
  const keys = deletedIds.flatMap((id) => {
    const ref = seenDossiers.get(id)
    return ref ? dossierKeys(ref) : []
  })
  let changed = false
  const map = new Map<SearchEntryKey, SearchEntryState>()
  for (const [key, entry] of entries.get()) {
    const ownScope = key.startsWith('dossier:') && deleted.has(key.slice('dossier:'.length))
    const affected =
      ownScope ||
      resultMentions(entry.result, deleted) ||
      resultMentions(entry.ranked, deleted) ||
      queryMentions(entry, keys)
    if (affected) {
      changed = true
      latestRequest.delete(key)
      continue
    }
    map.set(key, entry)
  }
  for (const id of deletedIds) seenDossiers.delete(id)
  if (changed) entries.set(map)
}

/**
 * Treffer nach Bedeutung kommen nach (#209, Bauplan 6). Ohne Arbeit an der
 * Liste gilt die gerankte Reihenfolge der zweiten Antwort («passendste
 * zuerst»). Hat der USER schon gearbeitet, bleiben die angezeigten Dokumente
 * an ihrer Stelle — jedes aber in der Fassung der zweiten Antwort (neue
 * Fundstellen erscheinen) — und neue kommen unten dazu.
 */
export function mergeSemanticResult(
  shown: SearchQueryResult,
  next: SearchQueryResult,
  keepOrder: boolean
): SearchQueryResult {
  if (!keepOrder) return next
  const fresh = new Map(next.results.map((d) => [d.sessionId, d]))
  const known = new Set(shown.results.map((d) => d.sessionId))
  const kept = shown.results.map((d) => fresh.get(d.sessionId) ?? d)
  const added = next.results.filter((d) => !known.has(d.sessionId))
  return { ...next, results: [...kept, ...added] }
}

/** Weicht die angezeigte Reihenfolge von der gerankten ab? */
export function isReordered(entry: SearchEntryState): boolean {
  const { result, ranked } = entry
  if (!result || !ranked || result === ranked) return false
  if (result.results.length !== ranked.results.length) return true
  return result.results.some((d, i) => d.sessionId !== ranked.results[i].sessionId)
}

/** «Nach Relevanz sortieren» bzw. erneutes Öffnen: Reihenfolge der Antwort herstellen. */
export function restoreRankedOrder(key: SearchEntryKey): void {
  const entry = getSearchEntry(key)
  if (!isReordered(entry)) return
  updateSearchEntry(key, { result: entry.ranked, interacted: false })
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
  seenDossiers.clear()
  searchModalOpen.set(false)
  returnFocus = null
}
