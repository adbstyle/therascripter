import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
// Keine echte PDF-Analyse nötig: die Erkennung gescannter Seiten fällt auf null
vi.mock('../../utils/pdfjs-loader', () => ({
  openPdfDocument: vi.fn().mockRejectedValue(new Error('kein PDF')),
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
  }> {
    return (await invokeHandlers.get('import:pdf')!({}, args)) as never
  }

  beforeEach(async () => {
    vi.resetModules()
    invokeHandlers.clear()
    enqueued.length = 0
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

  it('prüft alle Dateien vorab — eine ungültige legt kein PDF an', async () => {
    await expect(
      importPdf({
        filePaths: [sourcePdf('Gut.pdf'), join(SOURCE_DIR, 'fehlt.pdf')],
        dossierId
      })
    ).rejects.toThrow(/Datei nicht gefunden/)
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(enqueued).toEqual([])
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
