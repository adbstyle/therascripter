import { clipboard, ipcMain, shell } from 'electron'
import { buildClipboardPayload, buildFeedbackContent } from '../services/FeedbackService'

export async function sendFeedback(): Promise<void> {
  const content = buildFeedbackContent()

  // Always write the clipboard, regardless of whether the mail client opens.
  // AC #14: "Bei jedem Auslösen wird zusätzlich der vollständige Inhalt … in
  // die Zwischenablage geschrieben — unabhängig davon, ob der Mailclient
  // erfolgreich öffnet."
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
