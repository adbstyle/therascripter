import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SearchService } from '../search/SearchService'
import { validateIpc } from '../utils/ipc-helpers'
import {
  SearchQueryInputSchema,
  SearchRecentRememberSchema
} from '../../shared/validation/search-schemas'
import type { RecentSearchQuery, SearchQueryResult } from '../../shared/types/Search'

// IPC der Suche (Epic #192 — #209, #211). PR S4 ergänzt search:open,
// search:semantic, search:retryModel und das Event search:availabilityChanged.

type Service = Pick<SearchService, 'query' | 'listRecent' | 'rememberRecent' | 'clearRecent'>

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

export function registerSearchHandlers(
  createService: () => Service = () => new SearchService(getDatabase())
): void {
  ipcMain.handle('search:query', (_event, args: unknown) =>
    handleSearchQuery(createService(), args)
  )
  ipcMain.handle('search:recent:list', () => handleSearchRecentList(createService()))
  ipcMain.handle('search:recent:remember', (_event, args: unknown) =>
    handleSearchRecentRemember(createService(), args)
  )
  ipcMain.handle('search:recent:clear', () => handleSearchRecentClear(createService()))
}
