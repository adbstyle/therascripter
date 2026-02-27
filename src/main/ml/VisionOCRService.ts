import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Task } from '../../shared/types'
import type { ExtractionResult } from '../../shared/types/PDFTypes'
import type { TaskExecutor } from '../services/task-executors'
import { SessionService } from '../services/SessionService'
import { getDatabase, getDataDir } from '../db/connection'
import { buildPDFTranscript } from '../utils/pdf-transcript-builder'

/** Timeout per OCR page in milliseconds */
const PAGE_TIMEOUT_MS = 30_000

interface VisionOCROutput {
  text: string
  confidence: number
  language: string
  pageNumber: number
}

export class VisionOCRService implements TaskExecutor {
  private getBinaryPath(): string {
    // In packaged app: resources/bin/vision-ocr
    // In dev: resources/bin/vision-ocr (built by scripts/setup-vision-ocr.sh)
    const devPath = join(app.getAppPath(), 'resources', 'bin', 'vision-ocr')
    if (existsSync(devPath)) return devPath

    const packagedPath = join(process.resourcesPath, 'bin', 'vision-ocr')
    if (existsSync(packagedPath)) return packagedPath

    throw new Error(
      'Vision OCR Binary nicht gefunden. Bitte führen Sie scripts/setup-vision-ocr.sh aus.'
    )
  }

  async execute(task: Task, onProgress: (progress: number) => void): Promise<void> {
    const db = getDatabase()
    const sessionService = new SessionService(db)
    const session = sessionService.getSession(task.sessionId)

    if (!session?.pdfPath) {
      throw new Error(`Session ${task.sessionId} hat keinen PDF-Pfad`)
    }

    // Load extraction data
    const extractedPath = join(getDataDir(), 'extracted', `${task.sessionId}.json`)
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
      const page = scannedPages[i]
      const ocrText = await this.ocrPage(binaryPath, session.pdfPath, page.pageNumber)

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

  private ocrPage(binaryPath: string, pdfPath: string, pageNumber: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-n', '10', binaryPath, '--pdf', pdfPath, '--page', pageNumber.toString()]

      const proc = spawn('nice', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM')
        reject(
          new Error(
            `OCR für Seite ${pageNumber} abgebrochen: Timeout nach ${Math.round(PAGE_TIMEOUT_MS / 1000)}s`
          )
        )
      }, PAGE_TIMEOUT_MS)

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('error', (error) => {
        clearTimeout(timeout)
        reject(new Error(`Vision OCR konnte nicht gestartet werden: ${error.message}`))
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)

        if (code !== 0) {
          reject(new Error(`Vision OCR Fehler auf Seite ${pageNumber} (Exit ${code}): ${stderr}`))
          return
        }

        try {
          const result = JSON.parse(stdout) as VisionOCROutput
          resolve(result.text)
        } catch {
          // If JSON parsing fails, use raw stdout as text
          resolve(stdout.trim())
        }
      })
    })
  }
}
