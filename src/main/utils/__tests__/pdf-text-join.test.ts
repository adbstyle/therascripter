import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api'
import { openPdfDocument } from '../pdfjs-loader'
import { joinTextItems } from '../pdf-text-join'

// Regression für Rechnungen/Formulare, deren Generator den Textraum spiegelt
// (CTM-y-Flip + negative Schriftgrösse + `Tz -100`) und zwischen jede Glyphe
// ein TJ-Kerning setzt: pdfjs liefert dann EIN Text-Item pro Glyphe. Das
// frühere `items.join(' ')` machte daraus „H a n s M u s t e r" — und flair
// taggte anschliessend Hunderte Einzelbuchstaben als PERSON.
//
// per-glyph.pdf ist handgeschrieben (Content-Stream unkomprimiert lesbar) und
// bildet genau dieses Layout nach.

const FIXTURES = join(__dirname, '__fixtures__')

async function pageItems(file: string): Promise<Array<TextItem | TextMarkedContent>> {
  const doc = await openPdfDocument(new Uint8Array(readFileSync(join(FIXTURES, file))))
  const page = await doc.getPage(1)
  return (await page.getTextContent()).items
}

/** Horizontales Text-Item im pdfjs-Format (transform = [a, b, c, d, e, f]). */
function item(str: string, x: number, y: number, width: number, opts: Partial<TextItem> = {}) {
  const size = 10
  return {
    str,
    dir: 'ltr',
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    fontName: 'f1',
    hasEOL: false,
    ...opts
  } satisfies TextItem
}

describe('joinTextItems mit echten pdfjs-Items', () => {
  it('liefert für das Spiegel-Layout tatsächlich ein Item pro Glyphe — sonst prüft der nächste Test nichts', async () => {
    const items = (await pageItems('per-glyph.pdf')).filter(
      (it): it is TextItem => 'str' in it && it.str.trim().length > 0
    )
    expect(items.length).toBeGreaterThan(15)
    expect(items.every((it) => it.str.length === 1)).toBe(true)
  })

  it('setzt Glyphen-Items zu Wörtern zusammen statt Leerzeichen zwischen jede Glyphe zu streuen', async () => {
    expect(joinTextItems(await pageItems('per-glyph.pdf'))).toBe('Hans Muster Zuerich')
  })

  it('lässt normale PDFs (ein Item pro Zeile) unverändert', async () => {
    expect(joinTextItems(await pageItems('base14.pdf'))).toBe(
      'Therascript PDF Fixture Zeile zwei 12345'
    )
  })
})

describe('joinTextItems — Geometrie-Grenzfälle', () => {
  it('verbindet sich berührende Glyphen ohne Trenner', () => {
    expect(joinTextItems([item('H', 0, 0, 7), item('a', 7, 0, 5), item('ns', 12, 0, 10)])).toBe(
      'Hans'
    )
  })

  it('verbindet auch bei leichtem Kerning-Überlapp', () => {
    expect(joinTextItems([item('W', 0, 0, 9), item('a', 8.5, 0, 5)])).toBe('Wa')
  })

  it('übernimmt von pdfjs eingefügte Leerzeichen-Items ohne sie zu verdoppeln', () => {
    expect(
      joinTextItems([item('Hans', 0, 0, 20), item(' ', 20, 0, 3), item('Muster', 23, 0, 30)])
    ).toBe('Hans Muster')
  })

  it('trennt an hasEOL — auch am leeren EOL-Marker-Item', () => {
    expect(
      joinTextItems([
        item('Hans', 0, 20, 20, { hasEOL: true }),
        item('Muster', 0, 0, 30),
        item('', 30, 0, 0, { hasEOL: true }),
        item('Zuerich', 0, -20, 35)
      ])
    ).toBe('Hans Muster Zuerich')
  })

  it('trennt bei Zeilenwechsel ohne hasEOL', () => {
    expect(joinTextItems([item('Hans', 0, 20, 20), item('Muster', 0, 0, 30)])).toBe('Hans Muster')
  })

  it('trennt bei Rücksprung auf derselben Grundlinie (Tabellenzelle)', () => {
    expect(joinTextItems([item('12,00 €', 200, 0, 30), item('1', 60, 0, 5)])).toBe('12,00 € 1')
  })

  it('trennt bei Vorwärtssprung ohne Leerzeichen-Item (Spalte)', () => {
    expect(joinTextItems([item('Name:', 0, 0, 25), item('Hans', 80, 0, 20)])).toBe('Name: Hans')
  })

  it('trennt hoch-/tiefgestellte Glyphen ab, damit ein Name nicht mit der Fussnote verklebt', () => {
    expect(joinTextItems([item('Müller', 0, 0, 30), item('1', 30, 4, 4)])).toBe('Müller 1')
  })

  it('ignoriert Marked-Content-Einträge', () => {
    expect(
      joinTextItems([
        { type: 'beginMarkedContent', id: 'mc0' },
        item('Ha', 0, 0, 10),
        { type: 'endMarkedContent', id: 'mc0' },
        item('ns', 10, 0, 10)
      ])
    ).toBe('Hans')
  })

  it('normalisiert Whitespace und trimmt', () => {
    expect(joinTextItems([item('  Hans ', 0, 0, 25), item('\tMuster  ', 25, 0, 35)])).toBe(
      'Hans Muster'
    )
  })
})
