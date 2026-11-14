import { ipcRenderer } from 'electron'
import type { RecentApi } from '../../shared/types/ipc/RecentApi'
import { RecentChangedSchema } from '../../shared/validation/change-event-schemas'

/** «Zuletzt geöffnet» (#213). Eingehende Events werden mit Zod geprüft. */
export const recentApi: RecentApi = {
  list: () => ipcRenderer.invoke('recent:list'),
  touch: (target) => ipcRenderer.invoke('recent:touch', target),
  onChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      if (RecentChangedSchema.safeParse(raw).success) callback()
    }
    ipcRenderer.on('recent:changed', handler)
    return () => {
      ipcRenderer.removeListener('recent:changed', handler)
    }
  }
}
