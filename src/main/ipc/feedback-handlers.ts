import { clipboard, ipcMain, shell } from 'electron'
import { buildClipboardPayload, buildFeedbackContent } from '../services/FeedbackService'

export async function sendFeedback(): Promise<void> {
  const content = buildFeedbackContent()

  // Clipboard write is the primary contract — mail-client open is best-effort.
  clipboard.writeText(buildClipboardPayload(content))

  try {
    await shell.openExternal(content.mailto)
  } catch (error) {
    console.warn('[feedback] Mailclient konnte nicht geöffnet werden:', error)
  }
}

export function registerFeedbackHandlers(): void {
  ipcMain.handle('feedback:send', async () => {
    await sendFeedback()
  })
}
