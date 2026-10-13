import { app, ipcMain, shell } from 'electron'
import { runSubprocess } from '../utils/subprocess'
import { sendToRenderer } from '../utils/ipc-helpers'
import { runningBundlePath } from '../services/app-update-deps'
import {
  ToolHealthService,
  getToolHealthService,
  setToolHealthService
} from '../services/ToolHealthService'
import type { ToolHealthState } from '../../shared/tool-blocked'

// Weg ohne Terminal (#168 AK 3): neu laden, im Ordner «Programme» ersetzen,
// «Dennoch öffnen» — genau das beschreibt die Installationsanleitung.
const INSTALL_GUIDE_URL = 'https://adbstyle.github.io/therascripter/installation.html#schritt-1'

/** Einmal beim Start (gepackte App: prüft und behebt im Hintergrund). */
export function initToolHealth(): ToolHealthService {
  const service = new ToolHealthService({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    bundlePath: runningBundlePath(),
    mainExecutable: app.getPath('exe'),
    run: (bin, args) => runSubprocess({ bin, args, timeoutMs: 30_000 }),
    onStateChange: (state) => sendToRenderer('toolHealth:state', state),
    log: (message) => console.log(message)
  })
  setToolHealthService(service)
  return service
}

export function registerToolHealthHandlers(): void {
  ipcMain.handle('toolHealth:getState', (): ToolHealthState | null => {
    return getToolHealthService()?.getState() ?? null
  })

  // «Erneut prüfen» nach einem Weg von Hand (z. B. Terminal-Befehl)
  ipcMain.handle('toolHealth:recheck', async (): Promise<ToolHealthState | null> => {
    const service = getToolHealthService()
    if (!service) return null
    await service.check()
    return service.getState()
  })

  ipcMain.handle('toolHealth:openGuide', async () => {
    await shell.openExternal(INSTALL_GUIDE_URL)
  })
}
