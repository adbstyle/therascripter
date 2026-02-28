import { ipcMain, nativeTheme } from 'electron'
import { getSettings } from '../services/SettingsService'
import { SettingsGetSchema, SettingsSetSchema } from '../../shared/validation/settings-schemas'

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (_event, args: unknown) => {
    const { key } = SettingsGetSchema.parse(args)
    return getSettings().get(key)
  })

  ipcMain.handle('settings:set', (_event, args: unknown) => {
    const { key, value } = SettingsSetSchema.parse(args)
    getSettings().set(key, value as never)

    // Sync Electron nativeTheme when theme preference changes
    if (key === 'theme') {
      const theme = value as string
      if (theme === 'light' || theme === 'dark') {
        nativeTheme.themeSource = theme
      } else {
        nativeTheme.themeSource = 'system'
      }
    }
  })
}
