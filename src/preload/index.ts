import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  IpcApi,
  TaskProgressData,
  TaskStartedData,
  TaskCompletedData,
  TaskErrorData,
  QueuePositionsData,
  ModelDownloadStatus
} from '../shared/types'
import {
  TaskProgressDataSchema,
  TaskStartedDataSchema,
  TaskCompletedDataSchema,
  TaskErrorDataSchema,
  QueuePositionsDataSchema
} from '../shared/validation/task-schemas'
import type { AppUpdateState } from '../shared/types/AppUpdate'
import type {
  SlotModelGroup,
  DiarizationPipeline
} from '../shared/validation/model-catalog-schemas'
import { SummaryChangedSchema } from '../shared/validation/summary-schemas'
import { ToolHealthStateSchema } from '../shared/validation/tool-health-schemas'
import { normalizeViewMode, type ViewMode } from '../shared/types/ViewMode'
import { NavCommandSchema, SessionsChangedSchema } from '../shared/validation/change-event-schemas'
import { searchApi } from './api/search'
import { recentApi } from './api/recent'

/**
 * Issue #203 — the saved view, read synchronously before any renderer code
 * runs: the first render already knows it, so neither view ever flashes
 * (AK 12). A failed read yields the pseudonymized view (AK 11).
 */
function readInitialViewMode(): ViewMode {
  try {
    return normalizeViewMode(ipcRenderer.sendSync('viewMode:getSync'))
  } catch {
    return normalizeViewMode(undefined)
  }
}
import { dossierApi } from './api/dossiers'
import { SKIP, createChannel } from './api/channelHub'
import { pendingEditsApi } from './api/pendingEdits'

/** Epic #192 — gespeicherte Seitenleiste vor dem ersten Render; im Zweifel eingeblendet. */
function readInitialSidebarOpen(): boolean {
  try {
    return ipcRenderer.sendSync('sidebarOpen:getSync') !== false
  } catch {
    return true
  }
}

// Event-Kanäle mit vielen Abonnenten: ein ipcRenderer.on pro Kanal, die
// Prüfung einmal hier festgelegt (api/channelHub.ts)
const onSessionsChanged = createChannel('sessions:changed', (data) => {
  const parsed = SessionsChangedSchema.safeParse(data)
  return parsed.success ? parsed.data : SKIP
})
const onTaskProgress = createChannel(
  'task:progress',
  (raw): TaskProgressData => TaskProgressDataSchema.parse(raw)
)
const onTaskStarted = createChannel(
  'task:started',
  (raw): TaskStartedData => TaskStartedDataSchema.parse(raw)
)
const onTaskCompleted = createChannel(
  'task:completed',
  (raw): TaskCompletedData => TaskCompletedDataSchema.parse(raw)
)
const onTaskError = createChannel(
  'task:error',
  (raw): TaskErrorData => TaskErrorDataSchema.parse(raw)
)
const onQueuePositions = createChannel(
  'queue:positions',
  (raw): QueuePositionsData => QueuePositionsDataSchema.parse(raw)
)
const onSummaryChanged = createChannel('summary:changed', (data) => {
  const parsed = SummaryChangedSchema.safeParse(data)
  return parsed.success ? parsed.data.sessionId : SKIP
})

const api: IpcApi = {
  sessions: {
    list: () => ipcRenderer.invoke('session:list'),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', { sessionId }),
    rename: (sessionId, title) => ipcRenderer.invoke('session:rename', { sessionId, title }),
    setDocumentDate: (sessionId, documentDate) =>
      ipcRenderer.invoke('session:setDocumentDate', { sessionId, documentDate }),
    onChanged: (callback) => onSessionsChanged(callback)
  },
  recording: {
    start: (options) =>
      ipcRenderer.invoke(
        'recording:start',
        options?.dossierId ? { dossierId: options.dossierId } : undefined
      ),
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
    onProgress: (callback) => onTaskProgress(callback),
    onStarted: (callback) => onTaskStarted(callback),
    onCompleted: (callback) => onTaskCompleted(callback),
    onError: (callback) => onTaskError(callback),
    onQueuePositions: (callback) => onQueuePositions(callback)
  },
  blocklist: {
    list: () => ipcRenderer.invoke('blocklist:list'),
    add: (term, placeholderType) => ipcRenderer.invoke('blocklist:add', { term, placeholderType }),
    update: (id, term, placeholderType) =>
      ipcRenderer.invoke('blocklist:update', { id, term, placeholderType }),
    delete: (id) => ipcRenderer.invoke('blocklist:delete', { id })
  },
  import: {
    pdf: (filePaths, options) =>
      ipcRenderer.invoke(
        'import:pdf',
        options?.dossierId ? { filePaths, dossierId: options.dossierId } : { filePaths }
      ),
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
    list: (group: SlotModelGroup) => ipcRenderer.invoke('modelCatalog:list', { group }),
    listAsr: () => ipcRenderer.invoke('modelCatalog:listAsr'),
    download: (id: string) => ipcRenderer.invoke('modelCatalog:download', { id }),
    delete: (id: string) => ipcRenderer.invoke('modelCatalog:delete', { id }),
    setActive: (group: SlotModelGroup, id: string) =>
      ipcRenderer.invoke('modelCatalog:setActive', { group, id }),
    clearActive: (group: SlotModelGroup) =>
      ipcRenderer.invoke('modelCatalog:clearActive', { group }),
    cancelDownload: () => ipcRenderer.invoke('modelCatalog:cancelDownload')
  },
  pipeline: {
    getDiarization: () => ipcRenderer.invoke('pipeline:getDiarization'),
    setDiarization: (pipeline: DiarizationPipeline) =>
      ipcRenderer.invoke('pipeline:setDiarization', { pipeline }),
    listDiarization: () => ipcRenderer.invoke('pipeline:listDiarization')
  },
  modelReconcile: {
    getEvents: () => ipcRenderer.invoke('modelReconcile:getEvents'),
    markSeen: () => ipcRenderer.invoke('modelReconcile:markSeen'),
    dismiss: () => ipcRenderer.invoke('modelReconcile:dismiss')
  },
  toolHealth: {
    getState: () => ipcRenderer.invoke('toolHealth:getState'),
    recheck: () => ipcRenderer.invoke('toolHealth:recheck'),
    openGuide: () => ipcRenderer.invoke('toolHealth:openGuide'),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        const parsed = ToolHealthStateSchema.safeParse(data)
        if (parsed.success) callback(parsed.data)
      }
      ipcRenderer.on('toolHealth:state', handler)
      return () => {
        ipcRenderer.removeListener('toolHealth:state', handler)
      }
    }
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke('appUpdate:getState'),
    check: () => ipcRenderer.invoke('appUpdate:check'),
    download: () => ipcRenderer.invoke('appUpdate:download'),
    cancelDownload: () => ipcRenderer.invoke('appUpdate:cancelDownload'),
    install: () => ipcRenderer.invoke('appUpdate:install'),
    setAutoUpdate: (enabled: boolean) => ipcRenderer.invoke('appUpdate:setAutoUpdate', { enabled }),
    openInstallGuide: () => ipcRenderer.invoke('appUpdate:openInstallGuide'),
    onState: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AppUpdateState): void =>
        callback(data)
      ipcRenderer.on('appUpdate:state', handler)
      return () => {
        ipcRenderer.removeListener('appUpdate:state', handler)
      }
    }
  },
  summary: {
    get: (sessionId: string) => ipcRenderer.invoke('summary:get', { sessionId }),
    updateTitle: (sessionId: string, title: string) =>
      ipcRenderer.invoke('summary:updateTitle', { sessionId, title }),
    updateText: (sessionId: string, text: string) =>
      ipcRenderer.invoke('summary:updateText', { sessionId, text }),
    missingReason: (sessionId: string) =>
      ipcRenderer.invoke('summary:missingReason', { sessionId }),
    regenerate: (sessionId: string) => ipcRenderer.invoke('summary:regenerate', { sessionId }),
    onChanged: (callback) => onSummaryChanged(callback)
  },
  microphone: {
    getState: () => ipcRenderer.invoke('microphone:getState'),
    ensureAccess: () => ipcRenderer.invoke('microphone:ensureAccess'),
    dismissHint: () => ipcRenderer.invoke('microphone:dismissHint'),
    openSettings: () => ipcRenderer.invoke('microphone:openSettings')
  },
  viewMode: {
    initial: readInitialViewMode(),
    set: (mode) => ipcRenderer.invoke('viewMode:set', { mode })
  },
  dossiers: dossierApi,
  search: searchApi,
  recent: recentApi,
  pendingEdits: pendingEditsApi,
  nav: {
    initialSidebarOpen: readInitialSidebarOpen(),
    onOpenSettings: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('nav:openSettings', handler)
      return () => {
        ipcRenderer.removeListener('nav:openSettings', handler)
      }
    },
    onCommand: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => {
        const parsed = NavCommandSchema.safeParse(data)
        if (parsed.success) callback(parsed.data)
      }
      ipcRenderer.on('nav:command', handler)
      return () => {
        ipcRenderer.removeListener('nav:command', handler)
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
