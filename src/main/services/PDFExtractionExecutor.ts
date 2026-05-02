import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { Task } from '../../shared/types'
import type { ExtractionResult, PageData } from '../../shared/types/PDFTypes'
import type { TaskExecutor } from './task-executors'
import { SessionService } from './SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { buildPDFTranscript } from '../utils/pdf-transcript-builder'
import { writeFileAtomic } from '../utils/file-ops'

/** Minimum characters on a page to consider it a text page (not scanned) */
const TEXT_PAGE_THRESHOLD = 50

export class PDFExtractionExecutor implements TaskExecutor {
  async execute(task: Task, onProgress: (progress: number) => void, _signal?: AbortSignal): Promise<void> {
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    if (!session?.pdfPath) {
      throw new Error(`Session ${task.sessionId} hat keinen PDF-Pfad`)
    }
    if (!existsSync(session.pdfPath)) {
      throw new Error(`PDF nicht gefunden: ${session.pdfPath}`)
    }

    onProgress(0.05)

    // Load pdfjs-dist (dynamic import for ESM compatibility)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // Resolve standard font data path for correct text extraction
    const require = createRequire(import.meta.url)
    const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
    const standardFontDataUrl = join(pdfjsDir, 'standard_fonts') + '/'

    const data = new Uint8Array(readFileSync(session.pdfPath))

    let doc
    try {
      doc = await pdfjs.getDocument({ data, standardFontDataUrl, useSystemFonts: false }).promise
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('password') || msg.includes('encrypted')) {
        throw new Error('Passwortgeschützte PDFs werden nicht unterstützt.')
      }
      throw new Error(`PDF konnte nicht geöffnet werden: ${msg}`)
    }

    onProgress(0.1)

    const totalPages = doc.numPages

    if (totalPages === 0) {
      throw new Error('Das PDF-Dokument ist leer (0 Seiten).')
    }

    const pages: PageData[] = []

    for (let i = 1; i <= totalPages; i++) {
      const page = await doc.getPage(i)
      const textContent = await page.getTextContent()

      const text = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()

      const contentType: PageData['contentType'] =
        text.length > TEXT_PAGE_THRESHOLD ? 'text' : 'scanned'

      pages.push({
        pageNumber: i,
        contentType,
        text: contentType === 'text' ? text : ''
      })

      onProgress(0.1 + (i / totalPages) * 0.85)
    }

    // Save extraction result
    const pdfMetadata = await doc.getMetadata().catch(() => null)
    const extractionResult: ExtractionResult = {
      pages,
      metadata: {
        totalPages,
        title: pdfMetadata?.info?.Title ?? undefined,
        author: pdfMetadata?.info?.Author ?? undefined
      }
    }

    const extractedPath = join(getDataDir(), 'extracted', `${task.sessionId}.json`)
    writeFileAtomic(extractedPath, JSON.stringify(extractionResult, null, 2))

    // Always write a transcript from extracted text — guarantees the
    // anonymization step has a transcriptPath to read even when the
    // import-time scanned-page heuristic disagrees with extraction-time
    // detection. If OCR runs after this, it overwrites the transcript with
    // a merged version that includes OCR'd scanned pages.
    const transcriptPath = buildPDFTranscript(task.sessionId, pages, 'pdfjs-dist', sessionService)

    // Single DB write so a crash between updates can't leave the session in
    // the (extractedPath set, transcriptPath null) state that previously
    // wedged retries at anonymization.
    sessionService.updateSession(task.sessionId, { extractedPath, transcriptPath })

    onProgress(1)
  }
}
