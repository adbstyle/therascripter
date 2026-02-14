import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IpcApi } from '../shared/types'

const api: IpcApi = {
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', { sessionId }),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title })
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('Failed to expose APIs:', error)
  }
} else {
  // @ts-expect-error Fallback for non-isolated context (should not happen in production)
  window.electron = electronAPI
  // @ts-expect-error Fallback for non-isolated context
  window.api = api
}
