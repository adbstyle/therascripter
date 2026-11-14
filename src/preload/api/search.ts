import { ipcRenderer } from 'electron'
import type { SearchApi } from '../../shared/types/ipc/SearchApi'

/** Suche (Epic #192 — #209, #211). */
export const searchApi: SearchApi = {
  query: (input) => ipcRenderer.invoke('search:query', input),
  recentList: () => ipcRenderer.invoke('search:recent:list'),
  recentRemember: (query) => ipcRenderer.invoke('search:recent:remember', { query }),
  recentClear: () => ipcRenderer.invoke('search:recent:clear')
}
