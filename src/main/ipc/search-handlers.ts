import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SearchService } from '../search/SearchService'
import { getSearchRuntime, warmupSearch } from '../search/searchRuntime'
import { validateIpc } from '../utils/ipc-helpers'
import {
  SearchQueryInputSchema,
  SearchRecentRememberSchema
} from '../../shared/validation/search-schemas'
import type {
  RecentSearchQuery,
  SearchProcessState,
  SearchQueryResult
} from '../../shared/types/Search'

// IPC der Suche (Epic #192 — #209, #211). PR S4: search:semantic,
// search:warmup und das Event search:processStateChanged (main/index.ts).
// search:open, search:retryModel und search:availabilityChanged kommen mit
// PR S2 (Bereitstellung des Suchmodells).

type Service = Pick<
  SearchService,
  'query' | 'semantic' | 'listRecent' | 'rememberRecent' | 'clearRecent'
>

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
  private latest = new Map<number, number>()

  begin(windowId: number, requestId: number): () => boolean {
    this.latest.set(windowId, requestId)
    return () => this.latest.get(windowId) !== requestId
  }

  end(windowId: number, requestId: number): void {
    if (this.latest.get(windowId) === requestId) this.latest.delete(windowId)
  }
}

export async function handleSearchSemantic(
  service: Pick<Service, 'semantic'>,
  tracker: SemanticRequestTracker,
  windowId: number,
  args: unknown
): Promise<SearchQueryResult> {
  const input = validateIpc(SearchQueryInputSchema, args, 'search:semantic')
  const isSuperseded = tracker.begin(windowId, input.requestId)
  try {
    return await service.semantic(input, { isSuperseded })
  } finally {
    tracker.end(windowId, input.requestId)
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

/** Ohne Laufzeit (früher Start, Tests): kein Prozess, Modell gilt als fehlend. */
const NO_RUNTIME_STATE: SearchProcessState = { phase: 'stopped', reason: 'model-missing' }

export async function handleSearchWarmup(): Promise<SearchProcessState> {
  const rt = getSearchRuntime()
  return rt ? warmupSearch(rt) : NO_RUNTIME_STATE
}

function defaultService(): SearchService {
  return new SearchService(getDatabase(), { semantic: getSearchRuntime()?.semanticDeps })
}

export function registerSearchHandlers(createService: () => Service = defaultService): void {
  const tracker = new SemanticRequestTracker()
  ipcMain.handle('search:query', (_event, args: unknown) =>
    handleSearchQuery(createService(), args)
  )
  ipcMain.handle('search:semantic', (event, args: unknown) =>
    handleSearchSemantic(createService(), tracker, event.sender.id, args)
  )
  ipcMain.handle('search:warmup', () => handleSearchWarmup())
  ipcMain.handle('search:recent:list', () => handleSearchRecentList(createService()))
  ipcMain.handle('search:recent:remember', (_event, args: unknown) =>
    handleSearchRecentRemember(createService(), args)
  )
  ipcMain.handle('search:recent:clear', () => handleSearchRecentClear(createService()))
}
