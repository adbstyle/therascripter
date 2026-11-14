import { ipcMain, nativeTheme } from 'electron'
import { getSettings } from '../services/SettingsService'
import { SettingsGetSchema, SettingsSetSchema } from '../../shared/validation/settings-schemas'
import { ViewModeSetSchema } from '../../shared/validation/view-mode-schemas'
import { normalizeViewMode, type ViewMode } from '../../shared/types/ViewMode'

/**
 * Issue #203 — saved view. Anything unreadable (corrupt store, unknown value)
 * counts as «no view chosen» and yields the pseudonymized view (AK 11).
 */
export function readViewMode(get: () => unknown): ViewMode {
  try {
    return normalizeViewMode(get())
  } catch {
    return normalizeViewMode(undefined)
  }
}

/** Validates and persists a chosen view; throws on anything but a known view. */
export function writeViewMode(args: unknown, set: (mode: ViewMode) => void): void {
  const { mode } = ViewModeSetSchema.parse(args)
  set(mode)
}

export function registerSettingsHandlers(): void {
  // Synchronous on purpose: the preload reads the view before the renderer's
  // first render, so the app never paints a moment in the other view (AK 12).
  ipcMain.on('viewMode:getSync', (event) => {
    event.returnValue = readViewMode(() => getSettings().get('viewMode'))
  })

  ipcMain.handle('viewMode:set', (_event, args: unknown) => {
    writeViewMode(args, (mode) => getSettings().set('viewMode', mode))
  })

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
