import { ipcMain } from 'electron'
import {
  dismissReconcileEvents,
  getReconcileEvents,
  markReconcileEventsSeen
} from '../services/ModelDownloadService'

/**
 * Renderer-facing IPC for the reconciler's pending events. The reconciler
 * itself runs at bootstrap (see `reconcileActiveModels` in
 * ModelDownloadService); these handlers expose its persisted output to the
 * BottomNav dot and the Settings → Modelle banner.
 *
 * Lifecycle exposed to the renderer:
 *   getReconcileEvents()     → read all events (pending + seen)
 *   markReconcileEventsSeen()→ called when Settings → Modelle mounts; the
 *                              dot disappears, banner stays.
 *   dismissReconcileEvents() → called when the user clicks "Verstanden";
 *                              all events are deleted from the store.
 */
export function registerModelReconcileHandlers(): void {
  ipcMain.handle('modelReconcile:getEvents', () => getReconcileEvents())
  ipcMain.handle('modelReconcile:markSeen', () => markReconcileEventsSeen())
  ipcMain.handle('modelReconcile:dismiss', () => {
    dismissReconcileEvents()
  })
}
