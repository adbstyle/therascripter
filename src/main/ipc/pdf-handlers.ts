import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { getDatabase, getDataDir } from '../db/connection'
import { openPdfDocument, releasePdfDocument } from '../utils/pdfjs-loader'
import { SessionService } from '../services/SessionService'
import { SessionDossierService } from '../services/SessionDossierService'
import { getTaskQueue } from '../services/TaskQueueService'
import { ImportPDFSchema } from '../../shared/validation/import-schemas'
import type { Session } from '../../shared/types'
import type { ImportPdfResult } from '../../shared/types/IpcApi'

/**
 * Issue #80 Phase G — quick scanned-pages heuristic run at PDF import time.
 *
 * We extract text from the first up-to-3 pages with pdfjs-dist; if the
 * combined text length is below a threshold (50 chars), the PDF is
 * considered "mostly scanned" and OCR will be required. This drives
 * Session.pdfHasScannedPages, which feeds computePlannedSteps so the
 * SessionCard's step counter shows the right total ("Schritt 1/3" with
 * OCR vs "Schritt 1/2" without) before extraction has actually run.
 *
 * The full page-by-page contentType detection still happens during
 * extraction (PDFExtractionExecutor) — this is just an early peek.
 *
 * Returns null on failure (corrupted PDF, encrypted, etc.) so the import
 * can proceed without OCR detection; the user-facing error path stays
 * with the extraction executor.
 */
async function detectScannedPages(pdfPath: string): Promise<boolean | null> {
  try {
    const data = new Uint8Array(readFileSync(pdfPath))
    const doc = await openPdfDocument(data)
    try {
      const samplePages = Math.min(3, doc.numPages)

      let totalText = ''
      for (let i = 1; i <= samplePages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        totalText += content.items.map((it) => ('str' in it ? it.str : '')).join('')
        if (totalText.length >= 50) break
      }
      return totalText.trim().length < 50
    } finally {
      releasePdfDocument(doc)
    }
  } catch {
    return null
  }
}

function formatDate(date: Date): string {
  const d = date.getDate().toString().padStart(2, '0')
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const y = date.getFullYear()
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${d}.${m}.${y} ${h}:${min}`
}

function generatePDFTitle(filePath: string): string {
  const name = basename(filePath, '.pdf')
  // If the filename is meaningful, use it; otherwise fall back to date
  if (name.length > 0 && name !== 'document') {
    return name
  }
  return `PDF ${formatDate(new Date())}`
}

export function registerPDFHandlers(): void {
  ipcMain.handle('import:pdf', async (_event, args: unknown): Promise<ImportPdfResult> => {
    const { filePaths, dossierId } = ImportPDFSchema.parse(args)
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const assignments = new SessionDossierService(db)
    const taskQueue = getTaskQueue()

    const sessions: Session[] = []
    const unassigned: ImportPdfResult['unassigned'] = []

    // Alle Dateien vorab prüfen: eine ungültige Datei bricht den Import ab,
    // bevor ein PDF angelegt ist — so geht keine Meldung über eine nicht
    // gelungene Zuordnung früherer PDFs verloren (#206 AK 2).
    for (const sourcePath of filePaths) {
      if (!existsSync(sourcePath)) {
        throw new Error(`Datei nicht gefunden: ${sourcePath}`)
      }

      if (!sourcePath.toLowerCase().endsWith('.pdf')) {
        throw new Error(`Nur PDF-Dateien werden unterstützt: ${basename(sourcePath)}`)
      }
    }

    for (const sourcePath of filePaths) {
      // Copy PDF to app data directory
      const title = generatePDFTitle(sourcePath)
      const session = sessionService.createSession(title, 'pdf')

      // #206 PC 2 — Zuordnung VOR jeder Verarbeitung (enqueuePipeline unten);
      // scheitert sie, wird das PDF trotzdem importiert und gemeldet (AK 2).
      if (dossierId !== undefined) {
        let assigned = false
        try {
          assigned = assignments.assign(session.id, dossierId).ok
        } catch (error) {
          console.error(
            `[PDF-Import] Zuordnung von ${session.id} zum Dossier fehlgeschlagen:`,
            error
          )
        }
        if (!assigned) unassigned.push({ sessionId: session.id, title })
      }

      const pdfDir = join(getDataDir(), 'pdf')
      const pdfPath = join(pdfDir, `${session.id}.pdf`)

      try {
        copyFileSync(sourcePath, pdfPath)
      } catch (err) {
        // Rollback: remove orphaned session and partial file
        sessionService.deleteSession(session.id)
        try {
          unlinkSync(pdfPath)
        } catch {
          // File may not have been created
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `PDF konnte nicht kopiert werden. Bitte stellen Sie sicher, dass die Datei lokal verfügbar ist.\n${basename(sourcePath)}: ${msg}`
        )
      }

      // Phase G — quick OCR-needed detection before enqueue so plannedSteps
      // can include the OCR step (or not) from the very first task:started.
      const hasScannedPages = await detectScannedPages(pdfPath)

      sessionService.updateSession(session.id, {
        pdfPath,
        pdfHasScannedPages: hasScannedPages
      })

      // Enqueue PDF processing pipeline
      taskQueue.enqueuePipeline(session.id, 'pdf')

      // Re-fetch session to get updated state
      const updated = sessionService.getSession(session.id)
      if (updated) sessions.push(updated)
    }

    return { sessions, unassigned }
  })

  ipcMain.handle('import:showPDFDialog', async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF-Dokumente', extensions: ['pdf'] }],
      message: 'PDF-Dokumente zur Pseudonymisierung auswählen'
    })

    if (result.canceled) return []
    return result.filePaths
  })
}
