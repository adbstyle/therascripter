import { getActiveSessionId } from '../ipc/recording-handlers'
import { getTaskQueue } from './TaskQueueService'
import { isModelDownloadRunning } from './ModelDownloadService'
import { isModelUpdateRunning } from './UpdateCheckService'

export type BusyReason = 'recording' | 'processing' | 'download'

/**
 * Was spricht gerade gegen einen Neustart der App? Eine gemeinsame Antwort
 * für App-Update (#164) und Modell-Update-Neustart: nie während einer
 * Aufnahme, eines laufenden oder wartenden Verarbeitungsschritts oder eines
 * Modell-Downloads. null = ein Neustart unterbricht nichts.
 */
export function currentWork(): BusyReason | null {
  if (getActiveSessionId() !== null) return 'recording'
  try {
    if (getTaskQueue().hasWork()) return 'processing'
  } catch {
    // TaskQueue noch nicht initialisiert — dann läuft auch nichts
  }
  if (isModelDownloadRunning() || isModelUpdateRunning()) return 'download'
  return null
}
