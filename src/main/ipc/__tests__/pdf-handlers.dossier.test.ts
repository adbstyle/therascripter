import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyTestSchema } from '../../db/__tests__/test-utils'

/**
 * #206 PC 2 / AK 2 — PDF-Import aus einem Patientendossier: jedes PDF wird
 * VOR Beginn seiner Verarbeitung (enqueuePipeline) zugeordnet; scheitert die
 * Zuordnung, wird es trotzdem importiert und mit Titel gemeldet.
 */

const TEST_DIR = mkdtempSync(join(tmpdir(), 'pdf-import-dossier-'))
const SOURCE_DIR = join(TEST_DIR, 'quelle')
mkdirSync(join(TEST_DIR, 'pdf'), { recursive: true })
mkdirSync(SOURCE_DIR, { recursive: true })

const invokeHandlers = new Map<string, (...args: unknown[]) => unknown>()
const enqueued = vi.hoisted(() => [] as Array<{ sessionId: string; assignedAtEnqueue: string[] }>)

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, fn)
    }
  },
  app: { getPath: vi.fn(() => TEST_DIR) },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))
vi.mock('../../db/connection', () => ({
  getDatabase: () => testDb,
  getDataDir: () => TEST_DIR
}))
// Keine echte PDF-Analyse nötig: die Erkennung gescannter Seiten fällt auf
// null. `duringDetect` läuft im await — dort löschen Tests Dossier oder PDF.
const detect = vi.hoisted(() => ({
  duringDetect: null as null | ((call: number) => void),
  calls: 0
}))
vi.mock('../../utils/pdfjs-loader', () => ({
  openPdfDocument: vi.fn(async () => {
    detect.calls++
    detect.duringDetect?.(detect.calls)
    throw new Error('kein PDF')
  }),
  releasePdfDocument: vi.fn()
}))
// Die Queue hält fest, welche Zuordnungen beim Einreihen schon bestanden
vi.mock('../../services/TaskQueueService', () => ({
  getTaskQueue: () => ({
    enqueuePipeline: (sessionId: string) => {
      const rows = testDb
        .prepare('SELECT dossier_id FROM session_dossiers WHERE session_id = ?')
        .all(sessionId) as Array<{ dossier_id: string }>
      enqueued.push({ sessionId, assignedAtEnqueue: rows.map((r) => r.dossier_id) })
      return []
    }
  })
}))

let testDb: Database.Database

describe('import:pdf aus einem Patientendossier (#206)', () => {
  let dossierId: string

  function sourcePdf(name: string): string {
    const path = join(SOURCE_DIR, name)
    writeFileSync(path, '%PDF-1.4')
    return path
  }

  async function importPdf(args: unknown): Promise<{
    sessions: Array<{ id: string; title: string }>
    unassigned: Array<{ sessionId: string; title: string }>
    failed: Array<{ title: string; reason: string }>
  }> {
    return (await invokeHandlers.get('import:pdf')!({}, args)) as never
  }

  beforeEach(async () => {
    vi.resetModules()
    invokeHandlers.clear()
    enqueued.length = 0
    detect.duringDetect = null
    detect.calls = 0
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyTestSchema(testDb)
    const { DossierService } = await import('../../services/DossierService')
    const created = new DossierService(testDb).create({ firstName: 'Lukas', lastName: 'Hofer' })
    if (!created.ok) throw new Error('setup')
    dossierId = created.dossier.id
    const { registerPDFHandlers } = await import('../pdf-handlers')
    registerPDFHandlers()
  })

  afterEach(() => {
    testDb.close()
    vi.restoreAllMocks()
  })

  it('ordnet jedes PDF vor Beginn seiner Verarbeitung zu (PC 2)', async () => {
    const result = await importPdf({
      filePaths: [sourcePdf('Austrittsbericht.pdf'), sourcePdf('Zuweisung.pdf')],
      dossierId
    })
    expect(result.unassigned).toEqual([])
    expect(result.sessions.map((s) => s.title)).toEqual(['Austrittsbericht', 'Zuweisung'])
    expect(enqueued).toEqual(
      result.sessions.map((s) => ({ sessionId: s.id, assignedAtEnqueue: [dossierId] }))
    )
  })

  it('ohne Dossier: keine Zuordnung, nichts zu melden (OOS 1)', async () => {
    const result = await importPdf({ filePaths: [sourcePdf('Bericht.pdf')] })
    expect(result.unassigned).toEqual([])
    expect(enqueued).toEqual([{ sessionId: result.sessions[0].id, assignedAtEnqueue: [] }])
  })

  it('importiert auch, wenn es das Dossier nicht mehr gibt — und nennt jedes PDF (PC 2, AK 2)', async () => {
    const result = await importPdf({
      filePaths: [sourcePdf('Austrittsbericht.pdf'), sourcePdf('Zuweisung.pdf')],
      dossierId: 'geloescht'
    })
    expect(result.sessions).toHaveLength(2)
    expect(enqueued).toHaveLength(2)
    expect(result.unassigned).toEqual(
      result.sessions.map((s) => ({ sessionId: s.id, title: s.title }))
    )
  })

  it('importiert auch, wenn die Zuordnung wirft — und nennt das PDF (PC 2, AK 2)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { SessionDossierService } = await import('../../services/SessionDossierService')
    vi.spyOn(SessionDossierService.prototype, 'assign').mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })
    const result = await importPdf({ filePaths: [sourcePdf('Bericht.pdf')], dossierId })
    expect(enqueued).toHaveLength(1)
    expect(result.unassigned).toEqual([{ sessionId: result.sessions[0].id, title: 'Bericht' }])
  })

  it('eine fehlende Datei bricht den Import nicht ab — sie wird mit Grund gemeldet', async () => {
    const result = await importPdf({
      filePaths: [sourcePdf('Gut.pdf'), join(SOURCE_DIR, 'fehlt.pdf')],
      dossierId
    })
    expect(result.sessions.map((s) => s.title)).toEqual(['Gut'])
    expect(result.failed).toEqual([{ title: 'fehlt.pdf', reason: 'Datei nicht gefunden' }])
    expect(enqueued).toHaveLength(1)
  })

  it('Kopierfehler der dritten von drei Dateien: die ersten zwei bleiben importiert und gemeldet (Review #225)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unreadable = sourcePdf('Gesperrt.pdf')
    chmodSync(unreadable, 0o000)
    try {
      const result = await importPdf({
        filePaths: [sourcePdf('Eins.pdf'), sourcePdf('Zwei.pdf'), unreadable],
        dossierId: 'geloescht'
      })
      expect(result.sessions.map((s) => s.title)).toEqual(['Eins', 'Zwei'])
      // Frühere Meldungen gehen nicht verloren
      expect(result.unassigned.map((u) => u.title)).toEqual(['Eins', 'Zwei'])
      expect(result.failed).toEqual([
        {
          title: 'Gesperrt',
          reason: 'Die Datei konnte nicht kopiert werden. Ist sie lokal verfügbar?'
        }
      ])
      // Rollback: keine Sitzung für die dritte Datei
      expect(testDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 })
      expect(enqueued).toHaveLength(2)
    } finally {
      chmodSync(unreadable, 0o644)
    }
  })

  it('Dossier wird während des Imports gelöscht: die übrigen PDFs werden importiert (Review #225)', async () => {
    const { DossierService } = await import('../../services/DossierService')
    const dossiers = new DossierService(testDb)
    // Während das ERSTE PDF analysiert wird, löscht der USER das Dossier samt
    // diesem (bisher einzigen, exklusiven) PDF
    detect.duringDetect = (call) => {
      if (call !== 1) return
      const preview = dossiers.deletePreview(dossierId)!
      expect(dossiers.deleteDossier(dossierId, preview.fingerprint)).toMatchObject({ ok: true })
    }
    const result = await importPdf({
      filePaths: [sourcePdf('Eins.pdf'), sourcePdf('Zwei.pdf'), sourcePdf('Drei.pdf')],
      dossierId
    })
    // Das erste ist gewollt weg (kein Fehler), die anderen sind importiert,
    // aber nicht mehr zuordenbar
    expect(result.sessions.map((s) => s.title)).toEqual(['Zwei', 'Drei'])
    expect(result.unassigned.map((u) => u.title)).toEqual(['Zwei', 'Drei'])
    expect(result.failed).toEqual([])
    expect(enqueued.map((e) => e.sessionId)).toEqual(result.sessions.map((s) => s.id))
  })

  it('PDF wird während des Imports gelöscht: still übersprungen, die übrigen importiert (Review #225)', async () => {
    const { SessionService } = await import('../../services/SessionService')
    detect.duringDetect = (call) => {
      if (call !== 2) return
      const row = testDb.prepare(`SELECT id FROM sessions WHERE title = 'Zwei'`).get() as {
        id: string
      }
      new SessionService(testDb).deleteSession(row.id)
    }
    const result = await importPdf({
      filePaths: [sourcePdf('Eins.pdf'), sourcePdf('Zwei.pdf'), sourcePdf('Drei.pdf')],
      dossierId
    })
    expect(result.sessions.map((s) => s.title)).toEqual(['Eins', 'Drei'])
    expect(result.unassigned).toEqual([])
    expect(result.failed).toEqual([])
    expect(enqueued).toHaveLength(2)
  })

  it('lehnt ungültige Argumente ab', async () => {
    await expect(importPdf({ filePaths: [sourcePdf('A.pdf')], dossierId: '' })).rejects.toThrow()
    await expect(
      importPdf({ filePaths: [sourcePdf('A.pdf')], dossierId, extra: true })
    ).rejects.toThrow()
  })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})
