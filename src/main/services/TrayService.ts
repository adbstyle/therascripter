import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'path'

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function getIconsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(app.getAppPath(), 'resources', 'icons')
}

function loadTemplateIcon(basename: string): NativeImage {
  const dir = getIconsDir()
  // createFromPath auto-resolves @2x sibling for HiDPI, so we point it at the @1x file.
  const image = nativeImage.createFromPath(join(dir, `${basename}.png`))
  image.setTemplateImage(true)
  return image
}

export class TrayService {
  private tray: Tray | null = null
  private idleIcon: NativeImage | null = null
  private recordingIcon: NativeImage | null = null
  private isRecording = false
  private onStopCallback: (() => void) | null = null
  private onOpenSettingsCallback: (() => void) | null = null

  init(): void {
    this.idleIcon = loadTemplateIcon('TrayIconTemplate')
    this.recordingIcon = loadTemplateIcon('TrayIconRecordingTemplate')
    this.tray = new Tray(this.idleIcon)
    this.tray.setToolTip('Therascript')
    this.rebuildMenu()
  }

  onStop(callback: () => void): void {
    this.onStopCallback = callback
  }

  onOpenSettings(callback: () => void): void {
    this.onOpenSettingsCallback = callback
  }

  setRecordingState(recording: boolean, duration?: number): void {
    if (!this.tray) return

    this.isRecording = recording

    if (recording) {
      this.tray.setImage(this.recordingIcon!)
      const durationStr = duration !== undefined ? formatDuration(duration) : '00:00:00'
      this.tray.setTitle(durationStr)
      this.tray.setToolTip(`Therascript – Aufnahme läuft ${durationStr}`)
    } else {
      this.tray.setImage(this.idleIcon!)
      this.tray.setTitle('')
      this.tray.setToolTip('Therascript')
    }

    this.rebuildMenu()
  }

  updateDuration(seconds: number): void {
    if (!this.tray || !this.isRecording) return
    const durationStr = formatDuration(seconds)
    this.tray.setTitle(durationStr)
    this.tray.setToolTip(`Therascript – Aufnahme läuft ${durationStr}`)
  }

  showWindow(): void {
    const windows = BrowserWindow.getAllWindows()
    const win = windows[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // Without steal, the app stays in the background when activated from a
    // status-item click while another app holds the foreground.
    if (process.platform === 'darwin') app.focus({ steal: true })
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
    this.onStopCallback = null
    this.onOpenSettingsCallback = null
    // Reset singleton so initTray() can re-create if needed
    trayService = null
  }

  private rebuildMenu(): void {
    if (!this.tray) return

    const menuItems: Electron.MenuItemConstructorOptions[] = [
      {
        label: `Therascript v${app.getVersion()}`,
        enabled: false
      },
      { type: 'separator' }
    ]

    if (this.isRecording) {
      menuItems.push({
        label: 'Aufnahme stoppen',
        click: () => this.onStopCallback?.()
      })
      menuItems.push({ type: 'separator' })
    }

    menuItems.push({
      label: 'Einstellungen…',
      // Application Menu owns the real ⌘, accelerator so it only fires when
      // Therascript is focused. Here we just show the shortcut hint.
      accelerator: 'CommandOrControl+,',
      registerAccelerator: false,
      click: () => {
        this.showWindow()
        this.onOpenSettingsCallback?.()
      }
    })

    menuItems.push({
      label: 'Fenster anzeigen',
      click: () => this.showWindow()
    })

    menuItems.push({ type: 'separator' })

    menuItems.push({
      label: 'Therascript beenden',
      // Application Menu owns the real ⌘Q via role: 'quit'.
      accelerator: 'CommandOrControl+Q',
      registerAccelerator: false,
      click: () => app.quit()
    })

    this.tray.setContextMenu(Menu.buildFromTemplate(menuItems))
  }
}

let trayService: TrayService | null = null

export function initTray(): TrayService {
  if (trayService) return trayService

  trayService = new TrayService()
  trayService.init()

  return trayService
}

export function getTray(): TrayService {
  if (!trayService) {
    throw new Error('TrayService not initialized. Call initTray() first.')
  }
  return trayService
}
