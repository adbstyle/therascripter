import { BrowserWindow } from 'electron'

export function sendToRenderer(channel: string, data?: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(channel, data)
  }
}
