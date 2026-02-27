import { app, BrowserWindow, Menu, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { generateIdleIcon, generateRecordingIcon } from '../utils/icon-generator'

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export class TrayService {
  private tray: Tray | null = null
  private idleIcon: NativeImage | null = null
  private recordingIcon: NativeImage | null = null
  private isRecording = false
  private onStopCallback: (() => void) | null = null

  init(): void {
    this.idleIcon = generateIdleIcon()
    this.recordingIcon = generateRecordingIcon()
    this.tray = new Tray(this.idleIcon)
    this.tray.setToolTip('Therascript')
    this.rebuildMenu()
  }

  onStop(callback: () => void): void {
    this.onStopCallback = callback
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
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
    this.onStopCallback = null
    // Reset singleton so initTray() can re-create if needed
    trayService = null
  }

  private rebuildMenu(): void {
    if (!this.tray) return

    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (this.isRecording) {
      menuItems.push({
        label: 'Aufnahme stoppen',
        click: () => this.onStopCallback?.()
      })
      menuItems.push({ type: 'separator' })
    }

    menuItems.push({
      label: 'Fenster anzeigen',
      click: () => this.showWindow()
    })

    menuItems.push({ type: 'separator' })

    menuItems.push({
      label: 'Beenden',
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
