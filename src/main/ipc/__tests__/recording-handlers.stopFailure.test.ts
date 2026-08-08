import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyTestSchema } from '../../db/__tests__/test-utils'
import type { TaskExecutor } from '../../services/task-executors'

// Regression-Test für den Review-Befund auf PR #114 (#1, Score 75):
// Wirft finalizeWavFile() beim Stop (z. B. ENOSPC nach einer 2-h-Aufnahme,
// ~1.4 GB), lief das Resume der Recording-Pause und das Zurücksetzen von
// activeSessionId nie — die GESAMTE Queue blieb bis zum App-Neustart
// eingefroren UND es konnte keine neue Aufnahme gestartet werden. Bei
// Auto-Stop/Tray wurde der Fehler zusätzlich still geschluckt.

const TEST_DIR = mkdtempSync(join(tmpdir(), 'recording-stop-failure-'))
// In Produktion bootstrapped initDatabase() diese Verzeichnisse
mkdirSync(join(TEST_DIR, 'audio'), { recursive: true })
mkdirSync(join(TEST_DIR, 'recovery'), { recursive: true })

// Handler-Registry: fängt ipcMain.handle/on ein, damit die Handler direkt
// aufrufbar sind
const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>()
const onHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, fn)
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => {
      onHandlers.set(channel, fn)
    }
  },
  app: { getPath: vi.fn(() => TEST_DIR), isPackaged: false },
  dialog: { showMessageBox: vi.fn() },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    show(): void {}
  },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() }
}))

vi.mock('../../db/connection', () => ({
  getDatabase: () => testDb,
  getDataDir: () => TEST_DIR
}))

vi.mock('../../utils/ipc-helpers', () => ({
  sendToRenderer: vi.fn()
}))

vi.mock('../../services/TrayService', () => ({
  getTray: () => ({ setRecordingState: vi.fn(), updateDuration: vi.fn() })
}))

vi.mock('../../services/ModelDownloadService', () => ({
  getActiveModelId: vi.fn().mockReturnValue(null),
  getModelById: vi.fn().mockReturnValue(null)
}))

vi.mock('../../services/SettingsService', () => ({
  getSettings: () => ({ get: () => ({}) })
}))

let testDb: Database.Database

describe('recording:stop bei fehlschlagendem finalizeWavFile', () => {
  // vi.resetModules() pro Test: recording-handlers hält Modul-State
  // (activeSessionId) und TaskQueueService einen Prozess-Singleton — beides
  // muss pro Test frisch sein, sonst leakt die geschlossene DB von Test 1.
  let queue: { stop(): void; registerExecutor(t: string, e: TaskExecutor): void; enqueuePipeline(id: string, t: string): unknown }
  let recordingHandlers: typeof import('../recording-handlers')
  let AudioFileServiceClass: typeof import('../../services/AudioFileService').AudioFileService

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    invokeHandlers.clear()
    onHandlers.clear()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyTestSchema(testDb)

    const tq = await import('../../services/TaskQueueService')
    queue = tq.initTaskQueue(testDb) as unknown as typeof queue
    AudioFileServiceClass = (await import('../../services/AudioFileService')).AudioFileService
    recordingHandlers = await import('../recording-handlers')
    recordingHandlers.registerRecordingHandlers()
  })

  afterEach(async () => {
    try {
      recordingHandlers.cleanupRecordingOnQuit()
    } catch {
      // egal — nur State-Reset
    }
    queue.stop()
    await new Promise((r) => setTimeout(r, 50))
    testDb.close()
    vi.restoreAllMocks()
  })

  it('gibt Queue UND Recording-State frei, auch wenn finalizeWavFile wirft', async () => {
    const { getActiveSessionId } = recordingHandlers

    // Aufnahme starten — pausiert die Queue
    const start = invokeHandlers.get('recording:start')!
    const { sessionId } = (await start()) as { sessionId: string }
    expect(getActiveSessionId()).toBe(sessionId)
    expect(
      (queue as unknown as { pausedForRecording: boolean }).pausedForRecording
    ).toBe(true)

    // finalizeWavFile wirft (ENOSPC-Szenario)
    vi.spyOn(AudioFileServiceClass.prototype, 'finalizeWavFile').mockImplementation(() => {
      const err = new Error('ENOSPC: no space left on device') as Error & { code: string }
      err.code = 'ENOSPC'
      throw err
    })

    // Stop schlägt fehl — der Fehler selbst darf propagieren (IPC-Rejection) …
    const stop = invokeHandlers.get('recording:stop')!
    expect(() => stop(null, { sessionId })).toThrow(/ENOSPC/)

    // … aber die App muss benutzbar bleiben:
    // 1. Queue nicht mehr pausiert
    expect(
      (queue as unknown as { pausedForRecording: boolean }).pausedForRecording
    ).toBe(false)
    // 2. Keine "laufende Aufnahme" mehr — neue Aufnahme möglich
    expect(getActiveSessionId()).toBeNull()
  })

  it('Queue verarbeitet nach fehlgeschlagenem Stop weiter (Verhaltensbeweis)', async () => {
    const start = invokeHandlers.get('recording:start')!
    const { sessionId } = (await start()) as { sessionId: string }

    vi.spyOn(AudioFileServiceClass.prototype, 'finalizeWavFile').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })
    const stop = invokeHandlers.get('recording:stop')!
    expect(() => stop(null, { sessionId })).toThrow()

    // Andere Session einreihen — muss trotz des fehlgeschlagenen Stops laufen
    let executed = 0
    const countingExecutor: TaskExecutor = {
      async execute(_task, onProgress) {
        executed++
        onProgress(1)
      }
    }
    queue.registerExecutor('diarization', countingExecutor)
    queue.registerExecutor('transcription', countingExecutor)
    queue.registerExecutor('alignment', countingExecutor)
    queue.registerExecutor('anonymization', countingExecutor)

    const { SessionRepository } = await import('../../db/repositories/SessionRepository')
    const other = new SessionRepository(testDb).create({
      title: 'Andere Session',
      type: 'audio',
      status: 'queued'
    })
    queue.enqueuePipeline(other.id, 'audio')
    await new Promise((r) => setTimeout(r, 300))

    expect(executed).toBeGreaterThan(0)
  })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})
