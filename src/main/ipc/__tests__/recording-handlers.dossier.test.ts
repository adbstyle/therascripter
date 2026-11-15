import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyTestSchema } from '../../db/__tests__/test-utils'

/**
 * #206 — Aufnahme aus einem Patientendossier heraus:
 * - PC 1: Zuordnung ab Beginn der Aufnahme; scheitert sie, läuft die
 *   Aufnahme trotzdem und der Renderer erfährt es ('failed', AK 2)
 * - PC 3: die Zuordnung bleibt, egal wie die Aufnahme endet (Stopp,
 *   Auto-Stopp, Stopp über das Menüleisten-Symbol, Fehler beim Stopp,
 *   Beenden der App, Absturz mit Wiederherstellung oder Verwerfen)
 * - eine zweite Aufnahme bleibt blockiert
 */

const TEST_DIR = mkdtempSync(join(tmpdir(), 'recording-dossier-'))
mkdirSync(join(TEST_DIR, 'audio'), { recursive: true })
mkdirSync(join(TEST_DIR, 'recovery'), { recursive: true })

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>()
const showMessageBox = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, fn)
    },
    on: vi.fn()
  },
  app: { getPath: vi.fn(() => TEST_DIR), isPackaged: false },
  dialog: { showMessageBox },
  Notification: class {
    show(): void {}
  },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() }
}))

vi.mock('../../db/connection', () => ({
  getDatabase: () => testDb,
  getDataDir: () => TEST_DIR
}))
vi.mock('../../utils/ipc-helpers', () => ({ sendToRenderer: vi.fn() }))
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

describe('recording:start aus einem Patientendossier (#206)', () => {
  let handlers: typeof import('../recording-handlers')
  let queue: { stop(): void }
  let AudioFileServiceClass: typeof import('../../services/AudioFileService').AudioFileService
  let SessionDossierServiceClass: typeof import('../../services/SessionDossierService').SessionDossierService
  let dossierId: string

  function assignedDossiers(sessionId: string): string[] {
    return (
      testDb
        .prepare('SELECT dossier_id FROM session_dossiers WHERE session_id = ?')
        .all(sessionId) as Array<{ dossier_id: string }>
    ).map((r) => r.dossier_id)
  }

  function status(sessionId: string): string {
    return (
      testDb.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
        status: string
      }
    ).status
  }

  async function start(args?: unknown): Promise<{ sessionId: string; assignment: string }> {
    return (await invokeHandlers.get('recording:start')!({}, args)) as {
      sessionId: string
      assignment: string
    }
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    invokeHandlers.clear()
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyTestSchema(testDb)

    const tq = await import('../../services/TaskQueueService')
    queue = tq.initTaskQueue(testDb)
    AudioFileServiceClass = (await import('../../services/AudioFileService')).AudioFileService
    SessionDossierServiceClass = (await import('../../services/SessionDossierService'))
      .SessionDossierService
    const { DossierService } = await import('../../services/DossierService')
    const created = new DossierService(testDb).create({ firstName: 'Lukas', lastName: 'Hofer' })
    if (!created.ok) throw new Error('setup')
    dossierId = created.dossier.id
    handlers = await import('../recording-handlers')
    handlers.registerRecordingHandlers()
  })

  afterEach(async () => {
    try {
      handlers.cleanupRecordingOnQuit()
    } catch {
      // nur State-Reset
    }
    vi.useRealTimers()
    queue.stop()
    await new Promise((r) => setTimeout(r, 30))
    testDb.close()
    vi.restoreAllMocks()
  })

  it('ordnet die Sitzung ab Beginn der Aufnahme zu (PC 1)', async () => {
    const { sessionId, assignment } = await start({ dossierId })
    expect(assignment).toBe('assigned')
    expect(status(sessionId)).toBe('recording')
    expect(assignedDossiers(sessionId)).toEqual([dossierId])
    expect(handlers.getActiveSessionId()).toBe(sessionId)
  })

  it('nimmt die gestartete Aufnahme in «Zuletzt geöffnet» auf (#213 AK 2)', async () => {
    const { sessionId } = await start()
    expect(testDb.prepare('SELECT session_id FROM recent_items').all()).toEqual([
      { session_id: sessionId }
    ])
    const { RecentService } = await import('../../services/RecentService')
    const list = new RecentService(testDb, {
      getActiveSessionId: handlers.getActiveSessionId
    }).list()
    expect(list[0]).toMatchObject({ kind: 'session', recording: true })
  })

  it('liefert Titel und Zeitpunkt der Sitzung zurück (Hinweis «nicht zugeordnet», AK 2)', async () => {
    const result = (await start({ dossierId: 'geloescht' })) as unknown as {
      sessionId: string
      title: string
      createdAt: string
    }
    const row = testDb
      .prepare('SELECT title, created_at FROM sessions WHERE id = ?')
      .get(result.sessionId) as { title: string; created_at: string }
    expect(result.title).toBe(row.title)
    expect(result.createdAt).toBe(row.created_at)
  })

  it('legt Zuordnung und «Zuletzt»-Eintrag erst nach der Audiodatei an (Review #225)', async () => {
    vi.spyOn(AudioFileServiceClass.prototype, 'initWavFile').mockImplementation(() => {
      throw new Error('EACCES')
    })
    await expect(start({ dossierId })).rejects.toThrow(/EACCES/)
    expect(handlers.getActiveSessionId()).toBeNull()
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM session_dossiers').get()).toEqual({ n: 0 })
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM recent_items').get()).toEqual({ n: 0 })
  })

  it('ohne Dossier: keine Zuordnung, Ergebnis «none» (OOS 1)', async () => {
    const { sessionId, assignment } = await start()
    expect(assignment).toBe('none')
    expect(assignedDossiers(sessionId)).toEqual([])
  })

  it('startet auch, wenn es das Dossier nicht mehr gibt — und meldet es (PC 1, AK 2)', async () => {
    const { sessionId, assignment } = await start({ dossierId: 'geloescht' })
    expect(assignment).toBe('failed')
    expect(status(sessionId)).toBe('recording')
    expect(handlers.getActiveSessionId()).toBe(sessionId)
    expect(assignedDossiers(sessionId)).toEqual([])
  })

  it('startet auch, wenn die Zuordnung wirft — und meldet es (PC 1, AK 2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(SessionDossierServiceClass.prototype, 'assign').mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })
    const { sessionId, assignment } = await start({ dossierId })
    expect(assignment).toBe('failed')
    expect(status(sessionId)).toBe('recording')
    expect(handlers.getActiveSessionId()).toBe(sessionId)
  })

  it('lehnt ungültige Argumente ab', async () => {
    await expect(start({ dossierId: '' })).rejects.toThrow()
    await expect(start({ dossierId, extra: 1 })).rejects.toThrow()
    expect(handlers.getActiveSessionId()).toBeNull()
  })

  it('blockiert eine zweite Aufnahme, auch aus einem Dossier', async () => {
    await start()
    await expect(start({ dossierId })).rejects.toThrow(/already in progress/)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 })
  })

  describe('Zuordnung bleibt, egal wie die Aufnahme endet (PC 3)', () => {
    it('Stopp', async () => {
      const { sessionId } = await start({ dossierId })
      await invokeHandlers.get('recording:stop')!({}, { sessionId })
      expect(status(sessionId)).not.toBe('recording')
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it('Stopp über das Menüleisten-Symbol', async () => {
      const { sessionId } = await start({ dossierId })
      handlers.stopRecordingFromTray()
      expect(status(sessionId)).toBe('queued')
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it('Auto-Stopp nach zwei Stunden', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      const { sessionId } = await start({ dossierId })
      const { AUTO_STOP_SECONDS } = await import('../../../shared/constants/recording')
      vi.advanceTimersByTime(AUTO_STOP_SECONDS * 1000)
      expect(handlers.getActiveSessionId()).toBeNull()
      expect(status(sessionId)).toBe('queued')
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it('Fehler beim Stopp', async () => {
      const { sessionId } = await start({ dossierId })
      vi.spyOn(AudioFileServiceClass.prototype, 'finalizeWavFile').mockImplementation(() => {
        throw new Error('ENOSPC')
      })
      expect(() => invokeHandlers.get('recording:stop')!({}, { sessionId })).toThrow(/ENOSPC/)
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it('Beenden der App während der Aufnahme', async () => {
      const { sessionId } = await start({ dossierId })
      handlers.cleanupRecordingOnQuit()
      expect(status(sessionId)).toBe('error')
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it.each([
      ['wiederhergestellt', 0, 'queued'],
      ['verworfen', 1, 'error']
    ])('Absturz, beim nächsten Start %s', async (_label, response, expected) => {
      const { sessionId } = await start({ dossierId })
      // Absturz: kein Stopp, kein Aufräumen — die Sitzung bleibt in «recording»
      vi.spyOn(AudioFileServiceClass.prototype, 'repairWavAfterCrash').mockReturnValue({
        durationSeconds: 90
      } as never)
      showMessageBox.mockResolvedValue({ response })
      await handlers.recoverCrashedRecordings()
      expect(status(sessionId)).toBe(expected)
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })

    it('Absturz ohne wiederherstellbares Audio', async () => {
      const { sessionId } = await start({ dossierId })
      vi.spyOn(AudioFileServiceClass.prototype, 'repairWavAfterCrash').mockReturnValue(
        null as never
      )
      await handlers.recoverCrashedRecordings()
      expect(status(sessionId)).toBe('error')
      expect(assignedDossiers(sessionId)).toEqual([dossierId])
    })
  })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})
