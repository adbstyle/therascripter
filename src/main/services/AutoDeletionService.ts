import { join } from 'path'
import { getDatabase, getDataDir } from '../db/connection'
import { fileExists, writeFile } from '../utils/file-ops'
import { SessionService } from './SessionService'

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

let timer: ReturnType<typeof setInterval> | null = null

export function startAutoDeletion(): void {
  if (timer) return

  runCleanup()
  timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS)
}

export function stopAutoDeletion(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function runCleanup(): void {
  try {
    const db = getDatabase()
    const service = new SessionService(db)
    const deleted = service.cleanupOldSessions()
    const cleaned = service.cleanupSourceFiles()

    if (cleaned > 0) {
      console.log(`Source File Cleanup: ${cleaned} source file(s) deleted`)
    }
    if (deleted > 0) {
      console.log(`Auto-Deletion: ${deleted} expired session(s) deleted`)
      db.pragma('wal_checkpoint(TRUNCATE)')
      db.exec('VACUUM')
    }
  } catch (error) {
    console.error('Auto-Deletion failed:', error)
  }
}

export function ensureSpotlightExclusion(): void {
  const dataDir = getDataDir()
  const markerPath = join(dataDir, '.metadata_never_index')
  if (!fileExists(markerPath)) {
    writeFile(markerPath, '', 0o600)
  }
}
