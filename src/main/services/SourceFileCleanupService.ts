import { getDatabase } from '../db/connection'
import { SessionService } from './SessionService'

// Löscht Audioaufnahmen und Original-PDFs 24 Stunden nach erfolgreicher
// Verarbeitung (Status 'review'). Text, Pseudonymisierung, Titel und
// Zusammenfassung bleiben, bis der USER die Sitzung selbst löscht — eine
// altersabhängige Löschung ganzer Sitzungen gibt es seit Issue #202 nicht mehr.
// Fehlgeschlagene Sitzungen erreichen 'review' nie, ihre Quelldatei bleibt
// deshalb für einen späteren Retry erhalten.

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

let timer: ReturnType<typeof setInterval> | null = null

export function startSourceFileCleanup(): void {
  if (timer) return

  runCleanup()
  timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS)
}

export function stopSourceFileCleanup(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function runCleanup(): void {
  try {
    const service = new SessionService(getDatabase())
    const cleaned = service.cleanupSourceFiles()
    if (cleaned > 0) {
      console.log(`Source File Cleanup: ${cleaned} source file(s) deleted`)
    }
  } catch (error) {
    console.error('Source File Cleanup failed:', error)
  }
}
