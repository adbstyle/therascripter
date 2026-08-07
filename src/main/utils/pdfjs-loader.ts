import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * Gemeinsamer pdfjs-Bootstrap: dynamischer ESM-Import + standardFontDataUrl-
 * Auflösung + getDocument-Aufruf. War verbatim dupliziert in pdf-handlers
 * (Scan-Detection beim Import) und PDFExtractionExecutor (Extraktions-Step).
 */
export async function openPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const require = createRequire(import.meta.url)
  const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
  const standardFontDataUrl = join(pdfjsDir, 'standard_fonts') + '/'
  return pdfjs.getDocument({ data, standardFontDataUrl, useSystemFonts: false }).promise
}
