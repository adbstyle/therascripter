import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { SearchAvailability } from '../../shared/types/Search'
import type { SearchApi } from '../../shared/types/ipc/SearchApi'

/** Suche (Epic #192 — #209, #210, #211). */
export const searchApi: SearchApi = {
  open: () => ipcRenderer.invoke('search:open'),
  retryModel: () => ipcRenderer.invoke('search:retryModel'),
  onAvailabilityChanged: (callback) => {
    const handler = (_event: IpcRendererEvent, availability: SearchAvailability): void =>
      callback(availability)
    ipcRenderer.on('search:availabilityChanged', handler)
    return () => ipcRenderer.removeListener('search:availabilityChanged', handler)
  },
  query: (input) => ipcRenderer.invoke('search:query', input),
  recentList: () => ipcRenderer.invoke('search:recent:list'),
  recentRemember: (query) => ipcRenderer.invoke('search:recent:remember', { query }),
  recentClear: () => ipcRenderer.invoke('search:recent:clear'),
  semantic: (input) => ipcRenderer.invoke('search:semantic', input)
}
