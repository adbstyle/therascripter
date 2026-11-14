import { ipcRenderer } from 'electron'
import {
  FLUSH_PENDING_EDITS_CHANNEL,
  PENDING_EDITS_FLUSHED_CHANNEL,
  type PendingEditsApi
} from '../../shared/types/ipc/PendingEditsApi'

/** Anfrage-IDs sind kurze Zeichenketten aus dem Main-Prozess. */
function isRequestId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64
}

export const pendingEditsApi: PendingEditsApi = {
  onFlushRequest: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      if (!isRequestId(raw)) return
      void (async () => {
        try {
          await handler()
        } catch (error) {
          console.error('[pendingEdits] Speichern beim Beenden fehlgeschlagen:', error)
        } finally {
          ipcRenderer.send(PENDING_EDITS_FLUSHED_CHANNEL, raw)
        }
      })()
    }
    ipcRenderer.on(FLUSH_PENDING_EDITS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(FLUSH_PENDING_EDITS_CHANNEL, listener)
    }
  }
}
