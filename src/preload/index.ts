import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  IpcApi,
  TaskProgressData,
  TaskCompletedData,
  TaskErrorData,
  ModelDownloadStatus
} from '../shared/types'
import type { PendingModelUpdate, AppUpdateStatus } from '../shared/types/ModelUpdate'
import type {
  ModelGroup,
  DiarizationPipeline
} from '../shared/validation/model-catalog-schemas'

const api: IpcApi = {
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', { sessionId }),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title })
  },
  recording: {
    start: () => ipcRenderer.invoke('recording:start'),
    stop: (sessionId) => ipcRenderer.invoke('recording:stop', { sessionId }),
    sendData: (sessionId, samples) => ipcRenderer.send('recording:data', { sessionId, samples }),
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
    getSessionTasks: (sessionId) => ipcRenderer.invoke('task:getSessionTasks', { sessionId }),
    isProcessing: () => ipcRenderer.invoke('task:isProcessing'),
    retry: (sessionId) => ipcRenderer.invoke('task:retry', { sessionId }),
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
    add: (term, placeholderType) => ipcRenderer.invoke('blocklist:add', { term, placeholderType }),
    update: (id, term, placeholderType) =>
      ipcRenderer.invoke('blocklist:update', { id, term, placeholderType }),
    delete: (id) => ipcRenderer.invoke('blocklist:delete', { id })
  },
  import: {
    pdf: (filePaths) => ipcRenderer.invoke('import:pdf', { filePaths }),
    showPDFDialog: () => ipcRenderer.invoke('import:showPDFDialog'),
    getPathForFile: (file) => webUtils.getPathForFile(file)
  },
  review: {
    load: (sessionId) => ipcRenderer.invoke('review:load', { sessionId }),
    save: (sessionId, document, entityMap) =>
      ipcRenderer.invoke('review:save', { sessionId, document, entityMap }),
    exportClipboard: (text) => ipcRenderer.invoke('review:exportClipboard', { text })
  },
  system: {
    aboutInfo: () => ipcRenderer.invoke('system:aboutInfo'),
    uninstall: () => ipcRenderer.invoke('system:uninstall'),
    openInFinder: (path) => ipcRenderer.invoke('system:openInFinder', { path })
  },
  modelDownload: {
    status: () => ipcRenderer.invoke('modelDownload:status'),
    checkDiskSpace: () => ipcRenderer.invoke('modelDownload:checkDiskSpace'),
    start: () => ipcRenderer.invoke('modelDownload:start'),
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ModelDownloadStatus): void =>
        callback(data)
      ipcRenderer.on('modelDownload:status', handler)
      return () => {
        ipcRenderer.removeListener('modelDownload:status', handler)
      }
    }
  },
  modelCatalog: {
    list: (group: ModelGroup) => ipcRenderer.invoke('modelCatalog:list', { group }),
    listAsr: () => ipcRenderer.invoke('modelCatalog:listAsr'),
    download: (id: string) => ipcRenderer.invoke('modelCatalog:download', { id }),
    delete: (id: string) => ipcRenderer.invoke('modelCatalog:delete', { id }),
    setActive: (group: ModelGroup, id: string) =>
      ipcRenderer.invoke('modelCatalog:setActive', { group, id }),
    cancelDownload: () => ipcRenderer.invoke('modelCatalog:cancelDownload')
  },
  pipeline: {
    getDiarization: () => ipcRenderer.invoke('pipeline:getDiarization'),
    setDiarization: (pipeline: DiarizationPipeline) =>
      ipcRenderer.invoke('pipeline:setDiarization', { pipeline }),
    listDiarization: () => ipcRenderer.invoke('pipeline:listDiarization')
  },
  modelUpdate: {
    check: () => ipcRenderer.invoke('modelUpdate:check'),
    restart: (updates: PendingModelUpdate[]) =>
      ipcRenderer.invoke('modelUpdate:restart', { updates }),
    startDownload: () => ipcRenderer.invoke('modelUpdate:startDownload'),
    getPending: () => ipcRenderer.invoke('modelUpdate:getPending'),
    clearPending: () => ipcRenderer.invoke('modelUpdate:clearPending'),
    onAvailable: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, updates: PendingModelUpdate[]): void =>
        callback(updates)
      ipcRenderer.on('modelUpdate:available', handler)
      return () => {
        ipcRenderer.removeListener('modelUpdate:available', handler)
      }
    },
    onDownloadProgress: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ModelDownloadStatus): void =>
        callback(data)
      ipcRenderer.on('modelUpdate:downloadProgress', handler)
      return () => {
        ipcRenderer.removeListener('modelUpdate:downloadProgress', handler)
      }
    },
    onDownloadComplete: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('modelUpdate:downloadComplete', handler)
      return () => {
        ipcRenderer.removeListener('modelUpdate:downloadComplete', handler)
      }
    },
    onDownloadError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
      ipcRenderer.on('modelUpdate:downloadError', handler)
      return () => {
        ipcRenderer.removeListener('modelUpdate:downloadError', handler)
      }
    }
  },
  appUpdate: {
    getStatus: () => ipcRenderer.invoke('appUpdate:getStatus'),
    check: () => ipcRenderer.invoke('appUpdate:check'),
    openReleasePage: () => ipcRenderer.invoke('appUpdate:openReleasePage'),
    onStatus: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AppUpdateStatus): void =>
        callback(data)
      ipcRenderer.on('appUpdate:status', handler)
      return () => {
        ipcRenderer.removeListener('appUpdate:status', handler)
      }
    }
  },
  summary: {
    get: (sessionId: string) => ipcRenderer.invoke('summary:get', { sessionId }),
    updateTitle: (sessionId: string, title: string) =>
      ipcRenderer.invoke('summary:updateTitle', { sessionId, title }),
    updateText: (sessionId: string, text: string) =>
      ipcRenderer.invoke('summary:updateText', { sessionId, text })
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
