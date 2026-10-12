import { getActiveSessionId } from '../ipc/recording-handlers'
import { getTaskQueue } from './TaskQueueService'
import { isModelDownloadRunning } from './ModelDownloadService'

export type BusyReason = 'recording' | 'processing' | 'download'

/**
 * Was spricht gerade gegen das Installieren eines Updates (#164, #167)? Nie
 * während einer Aufnahme, eines laufenden oder wartenden
 * Verarbeitungsschritts oder eines Modell-Downloads (Ersteinrichtung,
 * Einstellungen → Modelle). null = ein Neustart unterbricht nichts.
 */
export function currentWork(): BusyReason | null {
  if (getActiveSessionId() !== null) return 'recording'
  try {
    if (getTaskQueue().hasWork()) return 'processing'
  } catch {
    // TaskQueue noch nicht initialisiert — dann läuft auch nichts
  }
  if (isModelDownloadRunning()) return 'download'
  return null
}
