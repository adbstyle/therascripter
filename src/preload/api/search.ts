import { ipcRenderer } from 'electron'
import type { SearchApi } from '../../shared/types/ipc/SearchApi'
import { SearchProcessStateSchema } from '../../shared/validation/search-schemas'

/** Suche (Epic #192 — #209, #211). */
export const searchApi: SearchApi = {
  query: (input) => ipcRenderer.invoke('search:query', input),
  recentList: () => ipcRenderer.invoke('search:recent:list'),
  recentRemember: (query) => ipcRenderer.invoke('search:recent:remember', { query }),
  recentClear: () => ipcRenderer.invoke('search:recent:clear'),
  semantic: (input) => ipcRenderer.invoke('search:semantic', input),
  warmup: () => ipcRenderer.invoke('search:warmup'),
  onProcessStateChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
      const parsed = SearchProcessStateSchema.safeParse(data)
      if (parsed.success) callback(parsed.data)
    }
    ipcRenderer.on('search:processStateChanged', handler)
    return () => {
      ipcRenderer.removeListener('search:processStateChanged', handler)
    }
  }
}
