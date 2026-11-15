import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SearchService } from '../search/SearchService'
import { getSearchRuntime } from '../search/searchRuntime'
import { validateIpc } from '../utils/ipc-helpers'
import {
  SearchQueryInputSchema,
  SearchRecentRememberSchema
} from '../../shared/validation/search-schemas'
import type {
  RecentSearchQuery,
  SearchAvailability,
  SearchQueryResult,
  SearchScope
} from '../../shared/types/Search'

// IPC der Suche (Epic #192 — #209, #210, #211). search:open,
// search:retryModel und das Event search:availabilityChanged (PR S2;
// SearchAvailability trägt seit PR S4 auch `semantic`: Verarbeitung und
// Suchprozess); search:semantic (PR S4).

type Service = Pick<
  SearchService,
  'query' | 'semantic' | 'listRecent' | 'rememberRecent' | 'clearRecent'
>

/** Woher `search:open` und `search:retryModel` ihre Antwort nehmen. */
export interface SearchAvailabilityProvider {
  get: () => SearchAvailability
  /**
   * Beim Öffnen der Suche: Suchmodell und Vektoren vorladen (#209 AK 16) und
   * den Stand sofort liefern; ohne: nur `get`.
   */
  open?: () => SearchAvailability
  /** «Erneut versuchen» (#210 AK 5): wartet den Versuch ab. */
  retryModel: () => Promise<SearchAvailability>
}

export function handleSearchQuery(
  service: Pick<Service, 'query'>,
  args: unknown
): SearchQueryResult {
  return service.query(validateIpc(SearchQueryInputSchema, args, 'search:query'))
}

/**
 * Neueste Anfrage je Fenster: eine neuere Anfrage desselben Fensters löst
 * die ältere ab — die ältere endet am nächsten Haltepunkt mit 'superseded'
 * und hält den Suchprozess nicht weiter auf.
 */
export class SemanticRequestTracker {
  private latest = new Map<string, number>()

  /** Bereich: Gesamtsuche und Dossier-Suche desselben Fensters lösen sich nicht ab. */
  private key(windowId: number, scope: SearchScope): string {
    return scope.kind === 'all' ? `${windowId}:all` : `${windowId}:dossier:${scope.dossierId}`
  }

  begin(windowId: number, requestId: number, scope: SearchScope = { kind: 'all' }): () => boolean {
    const key = this.key(windowId, scope)
    this.latest.set(key, requestId)
    return () => this.latest.get(key) !== requestId
  }

  end(windowId: number, requestId: number, scope: SearchScope = { kind: 'all' }): void {
    const key = this.key(windowId, scope)
    if (this.latest.get(key) === requestId) this.latest.delete(key)
  }
}

export async function handleSearchSemantic(
  service: Pick<Service, 'semantic'>,
  tracker: SemanticRequestTracker,
  windowId: number,
  args: unknown
): Promise<SearchQueryResult> {
  const input = validateIpc(SearchQueryInputSchema, args, 'search:semantic')
  const isSuperseded = tracker.begin(windowId, input.requestId, input.scope)
  try {
    return await service.semantic(input, { isSuperseded })
  } finally {
    tracker.end(windowId, input.requestId, input.scope)
  }
}

export function handleSearchRecentList(service: Pick<Service, 'listRecent'>): RecentSearchQuery[] {
  return service.listRecent()
}

export function handleSearchRecentRemember(
  service: Pick<Service, 'rememberRecent'>,
  args: unknown
): void {
  const { query } = validateIpc(SearchRecentRememberSchema, args, 'search:recent:remember')
  service.rememberRecent(query)
}

export function handleSearchRecentClear(service: Pick<Service, 'clearRecent'>): void {
  service.clearRecent()
}

/** Beim Öffnen der Suche: Stand von Modell und Suche nach Bedeutung, Vorladen (#209 AK 16, #210 AK 4/5). */
export function handleSearchOpen(availability: SearchAvailabilityProvider): SearchAvailability {
  return (availability.open ?? availability.get)()
}

export function handleSearchRetryModel(
  availability: SearchAvailabilityProvider
): Promise<SearchAvailability> {
  return availability.retryModel()
}

function defaultService(): SearchService {
  return new SearchService(getDatabase(), { semantic: getSearchRuntime()?.semanticDeps })
}

export function registerSearchHandlers(
  availability: SearchAvailabilityProvider,
  createService: () => Service = defaultService
): void {
  const tracker = new SemanticRequestTracker()
  ipcMain.handle('search:open', () => handleSearchOpen(availability))
  ipcMain.handle('search:retryModel', () => handleSearchRetryModel(availability))
  ipcMain.handle('search:query', (_event, args: unknown) =>
    handleSearchQuery(createService(), args)
  )
  ipcMain.handle('search:semantic', (event, args: unknown) =>
    handleSearchSemantic(createService(), tracker, event.sender.id, args)
  )
  ipcMain.handle('search:recent:list', () => handleSearchRecentList(createService()))
  ipcMain.handle('search:recent:remember', (_event, args: unknown) =>
    handleSearchRecentRemember(createService(), args)
  )
  ipcMain.handle('search:recent:clear', () => handleSearchRecentClear(createService()))
}
