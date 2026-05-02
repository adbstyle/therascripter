import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import { createRequire } from 'module'
import { getDatabase, getDataDir } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { getTaskQueue } from '../services/TaskQueueService'
import { ImportPDFSchema } from '../../shared/validation/import-schemas'
import type { Session } from '../../shared/types'

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
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const require = createRequire(import.meta.url)
    const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
    const standardFontDataUrl = join(pdfjsDir, 'standard_fonts') + '/'

    const data = new Uint8Array(readFileSync(pdfPath))
    const doc = await pdfjs.getDocument({ data, standardFontDataUrl, useSystemFonts: false })
      .promise
    const samplePages = Math.min(3, doc.numPages)

    let totalText = ''
    for (let i = 1; i <= samplePages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      totalText += content.items.map((it) => ('str' in it ? it.str : '')).join('')
      if (totalText.length >= 50) break
    }
    return totalText.trim().length < 50
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
  ipcMain.handle('import:pdf', async (_event, args: unknown) => {
    const { filePaths } = ImportPDFSchema.parse(args)
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const taskQueue = getTaskQueue()

    const sessions: Session[] = []

    for (const sourcePath of filePaths) {
      if (!existsSync(sourcePath)) {
        throw new Error(`Datei nicht gefunden: ${sourcePath}`)
      }

      if (!sourcePath.toLowerCase().endsWith('.pdf')) {
        throw new Error(`Nur PDF-Dateien werden unterstützt: ${basename(sourcePath)}`)
      }

      // Copy PDF to app data directory
      const title = generatePDFTitle(sourcePath)
      const session = sessionService.createSession(title, 'pdf')

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

    return sessions
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
