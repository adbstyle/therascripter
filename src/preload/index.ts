import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IpcApi } from '../shared/types'

const api: IpcApi = {
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', { sessionId }),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title })
  },
  recording: {
    start: () => ipcRenderer.invoke('recording:start'),
    stop: (sessionId) => ipcRenderer.invoke('recording:stop', { sessionId }),
    sendData: (sessionId, samples) =>
      ipcRenderer.send('recording:data', { sessionId, samples }),
    onDuration: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { seconds: number }): void =>
        callback(data)
      ipcRenderer.on('recording:duration', handler)
      return () => {
        ipcRenderer.removeListener('recording:duration', handler)
      }
    },
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }): void =>
        callback(data)
      ipcRenderer.on('recording:error', handler)
      return () => {
        ipcRenderer.removeListener('recording:error', handler)
      }
    }
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
