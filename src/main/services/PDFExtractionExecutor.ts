import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Task } from '../../shared/types'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent } from 'pdfjs-dist/types/src/display/api'
import type { ExtractionResult, PageData } from '../../shared/types/PDFTypes'
import type { TaskExecutor } from './task-executors'
import { SessionService } from './SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { buildPDFTranscript } from '../utils/pdf-transcript-builder'
import { writeFileAtomic } from '../utils/file-ops'
import { abortable } from '../utils/abortable'
import { openPdfDocument } from '../utils/pdfjs-loader'

/** Minimum characters on a page to consider it a text page (not scanned) */
const TEXT_PAGE_THRESHOLD = 50

export class PDFExtractionExecutor implements TaskExecutor {
  async execute(
    task: Task,
    onProgress: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
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

    const data = new Uint8Array(readFileSync(session.pdfPath))

    // abortable(): ein in pdf.js hängender Await settlet trotzdem, wenn der
    // Watchdog abbricht — sonst wedged ein pathologisches PDF die
    // Single-Slot-Queue permanent (einziger Ausweg war App-Quit).
    let doc: PDFDocumentProxy
    try {
      doc = await abortable<PDFDocumentProxy>(openPdfDocument(data), signal)
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
      if (signal?.aborted) {
        throw new Error('Verarbeitung abgebrochen')
      }
      const page = await abortable<PDFPageProxy>(doc.getPage(i), signal)
      const textContent = await abortable<TextContent>(page.getTextContent(), signal)

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
    // pdfjs typt info nur als Object — Title/Author sind dokumentierte,
    // optionale PDF-Info-Dictionary-Felder.
    const info = pdfMetadata?.info as { Title?: string; Author?: string } | undefined
    const extractionResult: ExtractionResult = {
      pages,
      metadata: {
        totalPages,
        title: info?.Title ?? undefined,
        author: info?.Author ?? undefined
      }
    }

    const extractedPath = join(getDataDir(), 'extracted', `${task.sessionId}.json`)
    writeFileAtomic(extractedPath, JSON.stringify(extractionResult))

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
