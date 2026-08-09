import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type { ExtractionResult } from '../../shared/types/PDFTypes'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { buildPDFTranscript } from '../utils/pdf-transcript-builder'
import { runSubprocess } from '../utils/subprocess'

/** Timeout per OCR page in milliseconds */
const PAGE_TIMEOUT_MS = 30_000

/**
 * Merge hyphenated line breaks produced by OCR (e.g. "Al-\ntersheim" → "Altersheim").
 * Only joins when the character after the newline is lowercase — preserves real
 * compound words like "Zürich-\nOerlikon" where uppercase follows.
 */
export function dehyphenateOCRText(text: string): string {
  return text.replace(/([a-zäöüß])-\n([a-zäöüß])/g, '$1$2')
}

interface VisionOCROutput {
  text: string
  confidence: number
  language: string
  pageNumber: number
}

/**
 * Parse the vision-ocr CLI's JSON stdout. Throws on unparsable output —
 * previously raw stdout (e.g. a warning banner) was silently accepted as the
 * page's OCR text and landed in the transcript.
 */
export function parseVisionOCROutput(stdout: string, pageNumber: number): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(
      `Vision OCR lieferte für Seite ${pageNumber} keine gültige JSON-Ausgabe: ${stdout.slice(0, 200)}`
    )
  }
  const result = parsed as Partial<VisionOCROutput>
  if (typeof result.text !== 'string') {
    throw new Error(`Vision OCR Ausgabe für Seite ${pageNumber} enthält kein text-Feld`)
  }
  return dehyphenateOCRText(result.text)
}

export class VisionOCRService implements TaskExecutor {
  private getBinaryPath(): string {
    // isPackaged-Split wie in allen anderen Resolvern (WhisperService etc.):
    // Die gepackte App nutzt AUSSCHLIESSLICH das mitgelieferte Binary — ein
    // Dev-Checkout auf demselben Rechner darf es nicht shadowen.
    const binPath = app.isPackaged
      ? join(process.resourcesPath, 'bin', 'vision-ocr')
      : join(app.getAppPath(), 'resources', 'bin', 'vision-ocr')
    if (existsSync(binPath)) return binPath

    throw new Error(
      'Vision OCR Binary nicht gefunden. Bitte führen Sie scripts/setup-vision-ocr.sh aus.'
    )
  }

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

    // Load extraction data from DB-stored path (fallback for pre-migration sessions)
    const extractedPath =
      session.extractedPath ?? join(getDataDir(), 'extracted', `${task.sessionId}.json`)
    if (!existsSync(extractedPath)) {
      throw new Error(`Extraktionsdaten nicht gefunden: ${extractedPath}`)
    }

    const extraction = JSON.parse(readFileSync(extractedPath, 'utf-8')) as ExtractionResult

    // Find scanned pages that need OCR
    const scannedPages = extraction.pages.filter((p) => p.contentType === 'scanned')

    onProgress(0.05)

    // If no scanned pages, transcript already built by extraction step — skip
    if (scannedPages.length === 0) {
      onProgress(1)
      return
    }

    // Run OCR on each scanned page
    const binaryPath = this.getBinaryPath()

    for (let i = 0; i < scannedPages.length; i++) {
      if (signal?.aborted) {
        throw new Error('Verarbeitung reagiert nicht mehr')
      }
      const page = scannedPages[i]
      const ocrText = await this.ocrPage(binaryPath, session.pdfPath, page.pageNumber, signal)

      // Update the page text in extraction data
      const extractionPage = extraction.pages.find((p) => p.pageNumber === page.pageNumber)
      if (extractionPage) {
        extractionPage.text = ocrText
      }

      onProgress(0.05 + ((i + 1) / scannedPages.length) * 0.9)
    }

    // Build transcript from all pages (text + OCR results merged)
    const transcriptPath = buildPDFTranscript(
      task.sessionId,
      extraction.pages,
      'apple-vision-ocr',
      sessionService
    )
    sessionService.updateSession(task.sessionId, { transcriptPath })

    onProgress(1)
  }

  private async ocrPage(
    binaryPath: string,
    pdfPath: string,
    pageNumber: number,
    signal?: AbortSignal
  ): Promise<string> {
    let result
    try {
      result = await runSubprocess({
        bin: binaryPath,
        args: ['--pdf', pdfPath, '--page', pageNumber.toString()],
        nice: 10,
        timeoutMs: PAGE_TIMEOUT_MS,
        signal
      })
    } catch (error) {
      throw new Error(
        `Vision OCR konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (result.aborted) {
      throw new Error('Verarbeitung reagiert nicht mehr')
    }
    if (result.timedOut) {
      throw new Error(
        `OCR für Seite ${pageNumber} abgebrochen: Timeout nach ${Math.round(PAGE_TIMEOUT_MS / 1000)}s`
      )
    }
    if (result.code !== 0) {
      throw new Error(
        `Vision OCR Fehler auf Seite ${pageNumber} (Exit ${result.code}): ${result.stderr}`
      )
    }

    return parseVisionOCROutput(result.stdout, pageNumber)
  }
}
