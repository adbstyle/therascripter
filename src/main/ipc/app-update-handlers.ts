import { ipcMain, shell } from 'electron'
import { getSettings } from '../services/SettingsService'
import { checkForUpdates } from '../services/UpdateCheckService'
import { AppUpdateStatusSchema } from '../../shared/validation/model-update-schemas'

const GITHUB_RELEASES_URL = 'https://github.com/adbstyle/therascripter/releases/latest'

export function registerAppUpdateHandlers(): void {
  // Return cached app update status (no network) — used by renderer on mount
  ipcMain.handle('appUpdate:getStatus', () => {
    const raw = getSettings().get('cachedAppUpdateStatus')
    const parsed = AppUpdateStatusSchema.safeParse(raw)
    if (!parsed.success) return { available: false, latestVersion: null, checkedAt: null }
    return parsed.data
  })

  // Trigger a full consolidated check (model + app) — used by About page manual check
  ipcMain.handle('appUpdate:check', async () => {
    return checkForUpdates()
  })

  // Open GitHub releases page in default browser
  ipcMain.handle('appUpdate:openReleasePage', async () => {
    await shell.openExternal(GITHUB_RELEASES_URL)
  })
}
