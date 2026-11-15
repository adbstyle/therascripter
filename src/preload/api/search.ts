import { ipcRenderer } from 'electron'
import { createChannel } from './channelHub'
import type { SearchAvailability } from '../../shared/types/Search'
import type { SearchApi } from '../../shared/types/ipc/SearchApi'

const onAvailabilityChanged = createChannel(
  'search:availabilityChanged',
  (raw) => raw as SearchAvailability
)

/** Suche (Epic #192 — #209, #210, #211). */
export const searchApi: SearchApi = {
  open: () => ipcRenderer.invoke('search:open'),
  retryModel: () => ipcRenderer.invoke('search:retryModel'),
  onAvailabilityChanged: (callback) => onAvailabilityChanged(callback),
  query: (input) => ipcRenderer.invoke('search:query', input),
  recentList: () => ipcRenderer.invoke('search:recent:list'),
  recentRemember: (query) => ipcRenderer.invoke('search:recent:remember', { query }),
  recentClear: () => ipcRenderer.invoke('search:recent:clear'),
  semantic: (input) => ipcRenderer.invoke('search:semantic', input)
}
