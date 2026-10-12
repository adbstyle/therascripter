import { ipcMain, shell } from 'electron'
import {
  createElectronMicrophoneDeps,
  dismissMicrophoneHint,
  ensureMicrophoneAccess,
  getMicrophoneState
} from '../services/MicrophoneService'

// Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon
const MICROPHONE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

export function registerMicrophoneHandlers(): void {
  const deps = createElectronMicrophoneDeps()

  ipcMain.handle('microphone:getState', () => getMicrophoneState(deps))
  ipcMain.handle('microphone:ensureAccess', () => ensureMicrophoneAccess(deps))
  ipcMain.handle('microphone:dismissHint', () => dismissMicrophoneHint(deps))
  ipcMain.handle('microphone:openSettings', async () => {
    await shell.openExternal(MICROPHONE_SETTINGS_URL)
  })
}
