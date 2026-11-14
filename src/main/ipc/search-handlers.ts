import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SearchService } from '../search/SearchService'
import { validateIpc } from '../utils/ipc-helpers'
import {
  SearchQueryInputSchema,
  SearchRecentRememberSchema
} from '../../shared/validation/search-schemas'
import type {
  RecentSearchQuery,
  SearchAvailability,
  SearchQueryResult
} from '../../shared/types/Search'

// IPC der Suche (Epic #192 — #209, #210, #211). search:open, search:retryModel
// und das Event search:availabilityChanged (Suchmodell) kommen aus PR S2;
// PR S4 ergänzt search:semantic und in SearchAvailability Verarbeitung und
// Suchprozess.

type Service = Pick<SearchService, 'query' | 'listRecent' | 'rememberRecent' | 'clearRecent'>

/** Woher `search:open` und `search:retryModel` ihre Antwort nehmen. */
export interface SearchAvailabilityProvider {
  get: () => SearchAvailability
  /** «Erneut versuchen» (#210 AK 5): wartet den Versuch ab. */
  retryModel: () => Promise<SearchAvailability>
}

export function handleSearchQuery(service: Service, args: unknown): SearchQueryResult {
  return service.query(validateIpc(SearchQueryInputSchema, args, 'search:query'))
}

export function handleSearchRecentList(service: Service): RecentSearchQuery[] {
  return service.listRecent()
}

export function handleSearchRecentRemember(service: Service, args: unknown): void {
  const { query } = validateIpc(SearchRecentRememberSchema, args, 'search:recent:remember')
  service.rememberRecent(query)
}

export function handleSearchRecentClear(service: Service): void {
  service.clearRecent()
}

/** Beim Öffnen der Suche: Stand des Suchmodells (#210 AK 4/5). */
export function handleSearchOpen(availability: SearchAvailabilityProvider): SearchAvailability {
  return availability.get()
}

export function handleSearchRetryModel(
  availability: SearchAvailabilityProvider
): Promise<SearchAvailability> {
  return availability.retryModel()
}

export function registerSearchHandlers(
  availability: SearchAvailabilityProvider,
  createService: () => Service = () => new SearchService(getDatabase())
): void {
  ipcMain.handle('search:open', () => handleSearchOpen(availability))
  ipcMain.handle('search:retryModel', () => handleSearchRetryModel(availability))
  ipcMain.handle('search:query', (_event, args: unknown) =>
    handleSearchQuery(createService(), args)
  )
  ipcMain.handle('search:recent:list', () => handleSearchRecentList(createService()))
  ipcMain.handle('search:recent:remember', (_event, args: unknown) =>
    handleSearchRecentRemember(createService(), args)
  )
  ipcMain.handle('search:recent:clear', () => handleSearchRecentClear(createService()))
}
