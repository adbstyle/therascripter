import { ipcMain } from 'electron'
import { getSettings } from '../services/SettingsService'
import {
  checkForUpdates,
  triggerUpdateRestart,
  executeUpdates,
  dismissManifestVersions
} from '../services/UpdateCheckService'
import { getActiveSessionId } from './recording-handlers'
import { getTaskQueue } from '../services/TaskQueueService'
import {
  DismissUpdatesSchema,
  RestartUpdateSchema
} from '../../shared/validation/model-update-schemas'

export function registerModelUpdateHandlers(): void {
  // Check for updates (returns list of available model updates)
  ipcMain.handle('modelUpdate:check', async () => {
    const result = await checkForUpdates()
    return result.modelUpdates
  })

  // Restart to apply updates — refuses if recording or processing is active
  ipcMain.handle('modelUpdate:restart', (_event, args: unknown) => {
    const { updates } = RestartUpdateSchema.parse(args)

    // Guard: never restart during active recording or processing
    if (getActiveSessionId() !== null) {
      return { allowed: false, reason: 'recording' }
    }
    try {
      if (getTaskQueue().isProcessing()) {
        return { allowed: false, reason: 'processing' }
      }
    } catch {
      // TaskQueue may not be initialized in edge cases
    }

    triggerUpdateRestart(updates)
    return { allowed: true }
  })

  // Start downloading pending updates (called from ModelUpdateScreen after restart)
  ipcMain.handle('modelUpdate:startDownload', async () => {
    await executeUpdates()
  })

  // Get pending updates stored in settings (used by renderer on startup)
  ipcMain.handle('modelUpdate:getPending', () => {
    return getSettings().get('pendingModelUpdates') ?? null
  })

  // Clear pending updates (called when user skips the update)
  ipcMain.handle('modelUpdate:clearPending', () => {
    getSettings().set('pendingModelUpdates', null)
  })

  // Issue #84 / Story F+G — record manifest entries the user actively
  // dismissed. Subsequent checkForUpdates calls filter these out until the
  // manifest publishes a new sha256 for the same id.
  ipcMain.handle('modelUpdate:dismissVersions', (_event, args: unknown) => {
    const { updates } = DismissUpdatesSchema.parse(args)
    dismissManifestVersions(updates.map((u) => ({ id: u.id, sha256: u.sha256 })))
  })
}
