import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  IpcApi,
  TaskProgressData,
  TaskCompletedData,
  TaskErrorData
} from '../shared/types'

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
    },
    onAutoStopped: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('recording:auto-stopped', handler)
      return () => {
        ipcRenderer.removeListener('recording:auto-stopped', handler)
      }
    }
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', { key }),
    set: (key, value) => ipcRenderer.invoke('settings:set', { key, value })
  },
  tasks: {
    getSessionTasks: (sessionId) =>
      ipcRenderer.invoke('task:getSessionTasks', { sessionId }),
    onProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TaskProgressData): void =>
        callback(data)
      ipcRenderer.on('task:progress', handler)
      return () => {
        ipcRenderer.removeListener('task:progress', handler)
      }
    },
    onCompleted: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TaskCompletedData): void =>
        callback(data)
      ipcRenderer.on('task:completed', handler)
      return () => {
        ipcRenderer.removeListener('task:completed', handler)
      }
    },
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TaskErrorData): void =>
        callback(data)
      ipcRenderer.on('task:error', handler)
      return () => {
        ipcRenderer.removeListener('task:error', handler)
      }
    }
  },
  blocklist: {
    list: () => ipcRenderer.invoke('blocklist:list'),
    add: (term, placeholderType) =>
      ipcRenderer.invoke('blocklist:add', { term, placeholderType }),
    update: (id, term, placeholderType) =>
      ipcRenderer.invoke('blocklist:update', { id, term, placeholderType }),
    delete: (id) => ipcRenderer.invoke('blocklist:delete', { id })
  },
  import: {
    pdf: (filePaths) => ipcRenderer.invoke('import:pdf', { filePaths }),
    showPDFDialog: () => ipcRenderer.invoke('import:showPDFDialog'),
    getPathForFile: (file) => webUtils.getPathForFile(file)
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
