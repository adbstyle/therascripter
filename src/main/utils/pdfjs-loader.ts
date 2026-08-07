import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * Minimaler 2D-Affin-Matrix-Stub für `globalThis.DOMMatrix`.
 *
 * WARUM DAS SEIN MUSS: pdfjs-dist wertet auf Modul-Top-Level
 * `const SCALE_MATRIX = new DOMMatrix()` aus (pdf.mjs, canvas-Sektion). In
 * Node/Electron-Main existiert kein natives DOMMatrix; pdfjs polyfillt es dort
 * ausschliesslich aus dem optionalen Paket `@napi-rs/canvas` und scheitert
 * dabei nur mit einem `warn()`. Ohne die Global lässt sich pdfjs also nicht
 * einmal IMPORTIEREN — unabhängig davon, welche API man danach aufruft. Die
 * 25 MB Skia-Native-Lib von @napi-rs/canvas sind nicht fürs Rastern nötig,
 * sie sind die Eintrittskarte zum Import. Wir liefern sie nicht mit (sie ist
 * in electron-builder.yml ausgeschlossen), also stellen wir die Global selbst.
 *
 * WARUM DAS AUSREICHT: Für den reinen Text-Pfad (getDocument → getPage →
 * getTextContent) wurde instrumentiert gemessen: genau EINE Konstruktion mit
 * null Argumenten, KEIN einziger Property-Zugriff. Die Methoden unten sind
 * dennoch mathematisch korrekt implementiert (statt zu werfen), damit ein
 * künftiger pdfjs-Pfad, der sie doch berührt, richtig rechnet statt zu
 * crashen. Dieselbe Form liefert `unpdf` (unjs) produktiv aus.
 *
 * WARUM ImageData/Path2D NICHT gestubbt werden: sie werden auf dem Text-Pfad
 * nie berührt (gemessen) und nur in Funktionskörpern verwendet, nie
 * top-level. Leere Stubs würden ein künftiges echtes Problem in stille
 * Falschergebnisse verwandeln — ein lauter Crash ist dort das bessere
 * Verhalten. Die zwei `warn()`-Zeilen von pdfjs nehmen wir dafür in Kauf.
 *
 * Abgesichert durch `__tests__/pdfjs-loader.test.ts`, der @napi-rs/canvas
 * unauflösbar macht und damit den gepackten Zustand simuliert.
 */
class DOMMatrixStub {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
    }
  }

  /** Post-multiplikation mit einer Translation (wie DOMMatrix.translateSelf). */
  translateSelf(tx = 0, ty = 0): this {
    this.e += tx * this.a + ty * this.c
    this.f += tx * this.b + ty * this.d
    return this
  }

  /** Post-multiplikation mit einer Skalierung (wie DOMMatrix.scaleSelf). */
  scaleSelf(sx = 1, sy = sx): this {
    this.a *= sx
    this.b *= sx
    this.c *= sy
    this.d *= sy
    return this
  }
}

/**
 * Installiert die Browser-Globals, die pdfjs beim Import erwartet. Idempotent
 * und nicht-destruktiv: ein bereits vorhandenes (natives oder von
 * @napi-rs/canvas geliefertes) DOMMatrix bleibt unangetastet — pdfjs' eigener
 * Polyfill-Block ist seinerseits mit `if (!globalThis.DOMMatrix)` bewacht,
 * unser Wert hat also Vorrang, ohne etwas zu überschreiben.
 *
 * MUSS vor dem dynamischen `import()` von pdfjs laufen. Deshalb steht der
 * Aufruf unten im Funktionskörper und pdfjs wird NICHT statisch importiert.
 */
function installPdfjsBrowserGlobals(): void {
  if (!globalThis.DOMMatrix) {
    ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrixStub
  }
}

/**
 * Gemeinsamer pdfjs-Bootstrap: Browser-Global-Stubs + dynamischer Import +
 * standardFontDataUrl-Auflösung + getDocument-Aufruf. War verbatim dupliziert
 * in pdf-handlers (Scan-Detection beim Import) und PDFExtractionExecutor
 * (Extraktions-Step).
 */
export async function openPdfDocument(data: Uint8Array): Promise<PDFDocumentProxy> {
  installPdfjsBrowserGlobals()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const require = createRequire(import.meta.url)
  const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
  const standardFontDataUrl = join(pdfjsDir, 'standard_fonts') + '/'
  return pdfjs.getDocument({ data, standardFontDataUrl, useSystemFonts: false }).promise
}
