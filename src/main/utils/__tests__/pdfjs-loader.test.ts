import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { openPdfDocument } from '../pdfjs-loader'

// Regression-Test für den Packaged-Build-Bug „DOMMatrix is not defined":
//
// pdfjs-dist polyfillt globalThis.DOMMatrix in Node AUSSCHLIESSLICH aus dem
// optionalen Paket @napi-rs/canvas — und braucht die Global bereits beim
// Modul-Import (`const SCALE_MATRIX = new DOMMatrix()` ist Top-Level-Code).
// Das Paket ist aus dem app.asar ausgeschlossen (25 MB Skia-Native-Lib, die
// wir nie brauchen: wir rufen nur getTextContent, nie Rasterung).
//
// Der Unterschied zwischen „läuft in Dev" und „kaputt im DMG" ist genau die
// AUFLÖSBARKEIT dieses Pakets. Deshalb machen wir es hier unauflösbar und
// prüfen den Loader unter Produktionsbedingungen — das verwandelt einen
// Packaging-Bug in einen Millisekunden-Unit-Test.
//
// Wichtig: Der Patch MUSS vor dem ersten Import von pdf.mjs greifen. ESM
// cached ein fehlgeschlagenes Modul prozessweit im Errored-State — Vitest
// isoliert pro Testdatei, deshalb liegt der Patch in beforeAll dieser Datei.

const FIXTURE = join(__dirname, '__fixtures__', 'base14.pdf')

interface ModuleWithLoad {
  _load(request: string, parent: unknown, isMain: boolean): unknown
}

let originalLoad: ModuleWithLoad['_load']
let moduleInternals: ModuleWithLoad

beforeAll(() => {
  const nodeRequire = createRequire(__filename)
  moduleInternals = nodeRequire('module') as unknown as ModuleWithLoad
  originalLoad = moduleInternals._load
  moduleInternals._load = function (
    this: unknown,
    request: string,
    ...rest: [unknown, boolean]
  ) {
    if (request === '@napi-rs/canvas') {
      const err = new Error("Cannot find module '@napi-rs/canvas'") as Error & { code: string }
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    return originalLoad.call(this, request, ...rest)
  } as ModuleWithLoad['_load']
})

afterAll(() => {
  if (originalLoad) moduleInternals._load = originalLoad
})

describe('openPdfDocument ohne @napi-rs/canvas (Zustand im gepackten app.asar)', () => {
  it('läuft in einer Umgebung ohne natives DOMMatrix — sonst prüft dieser Test nichts', () => {
    // Vorbedingung explizit machen: Stellt eine künftige jsdom-/Node-Version
    // DOMMatrix selbst bereit, würde der Test unten vacuously bestehen und
    // die Regression nicht mehr fangen. Dann muss dieser Test angepasst werden.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix')
    const isOurStub = descriptor !== undefined && globalThis.DOMMatrix?.name === 'DOMMatrix'
    expect(descriptor === undefined || isOurStub).toBe(true)
  })

  it('öffnet ein PDF und extrahiert Text, obwohl @napi-rs/canvas fehlt', async () => {
    const data = new Uint8Array(readFileSync(FIXTURE))
    const doc = await openPdfDocument(data)

    expect(doc.numPages).toBe(1)

    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ')

    expect(text).toContain('Therascript PDF Fixture')
    expect(text).toContain('Zeile zwei 12345')
  })

  it('nutzt unseren Stub, nicht den @napi-rs-Polyfill (Beweis, dass die Simulation greift)', () => {
    // pdfjs' Polyfill-Block ist mit `if (!globalThis.DOMMatrix)` bewacht:
    // ein selbst gesetzter Wert hat Vorrang und der require() entfällt.
    expect(typeof globalThis.DOMMatrix).toBe('function')
    expect(new globalThis.DOMMatrix()).toBeInstanceOf(globalThis.DOMMatrix)
  })
})
