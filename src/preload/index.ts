import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose Electron APIs to renderer via contextBridge.
// In later iterations, app-specific APIs (session:list, recording:start, etc.)
// will be added here with Zod validation.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
  } catch (error) {
    console.error('Failed to expose electron API:', error)
  }
} else {
  // @ts-expect-error Fallback for non-isolated context (should not happen in production)
  window.electron = electronAPI
}
