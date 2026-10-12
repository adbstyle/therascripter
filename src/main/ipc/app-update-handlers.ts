import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { checkForUpdates } from '../services/UpdateCheckService'
import { getAppUpdateService } from '../services/app-update-deps'
import type { AppUpdateInstallResult, AppUpdateState } from '../../shared/types/AppUpdate'

// Ausweg, wenn sich die App nicht selbst ersetzen kann (#164 AK 9): die
// Installationsanleitung mit dem Update-Weg von Hand (#160)
const INSTALL_GUIDE_URL = 'https://adbstyle.github.io/therascripter/installation.html#update'

const SetAutoUpdateSchema = z.object({ enabled: z.boolean() })

function service() {
  const s = getAppUpdateService()
  if (!s) throw new Error('App-Update nicht initialisiert')
  return s
}

export function registerAppUpdateHandlers(): void {
  ipcMain.handle('appUpdate:getState', (): AppUpdateState => service().getState())

  // «Nach Updates suchen»: Ergebnis kommt über appUpdate:state
  ipcMain.handle('appUpdate:check', async (): Promise<AppUpdateState> => {
    await checkForUpdates()
    return service().getState()
  })

  ipcMain.handle('appUpdate:download', () => {
    void service().download({ manual: true })
  })

  ipcMain.handle('appUpdate:cancelDownload', () => service().cancelDownload())

  ipcMain.handle('appUpdate:install', (): AppUpdateInstallResult => service().requestInstall())

  ipcMain.handle('appUpdate:setAutoUpdate', (_event, args: unknown) => {
    const { enabled } = SetAutoUpdateSchema.parse(args)
    service().setAutoUpdate(enabled)
  })

  ipcMain.handle('appUpdate:openInstallGuide', async () => {
    await shell.openExternal(INSTALL_GUIDE_URL)
  })
}
