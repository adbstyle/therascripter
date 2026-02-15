import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, copyFileSync } from 'fs'
import { basename, join } from 'path'
import { getDatabase, getDataDir } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { getTaskQueue } from '../services/TaskQueueService'
import { ImportPDFSchema } from '../../shared/validation/import-schemas'
import type { Session } from '../../shared/types'

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
      copyFileSync(sourcePath, pdfPath)

      sessionService.updateSession(session.id, { pdfPath })

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
      message: 'PDF-Dokumente zum Anonymisieren auswählen'
    })

    if (result.canceled) return []
    return result.filePaths
  })
}
