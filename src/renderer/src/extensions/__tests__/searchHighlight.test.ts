import { describe, it, expect, afterEach, vi } from 'vitest'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'
import {
  hasSearchHighlight,
  mapTextRange,
  paragraphTextMap,
  resolveSearchFocus,
  searchHighlightKey,
  setSearchHighlight
} from '../searchHighlight'
import { paragraphSearchText } from '../../../../main/search/chunker'
import type { TipTapDocument } from '../../../../shared/types/TipTapDocument'
import type { SearchFocus } from '../../../../shared/types/Search'

/**
 * #209 AK 11 — Fundstelle im Editor: Abbildung der Klartext-Offsets auf
 * ProseMirror-Positionen (Chips, Sprecher, Zeit, Emoji, zerlegte Umlaute),
 * Wiederfinden über den Anker und «nur Decorations».
 */

const chip = (original: string, number = 1, type = 'PERSON') => ({
  type: 'placeholderChip',
  attrs: { entityId: `${type.toLowerCase()}-${number}`, type, number, source: 'ner', original }
})
const text = (t: string) => ({ type: 'text', text: t })
const speaker = (label: string) => ({ type: 'speakerLabel', attrs: { speaker: label, label } })
const time = (formatted: string) => ({ type: 'timestamp', attrs: { seconds: 0, formatted } })

// «Zerlegte» Umlaute wie aus macOS-Eingaben: u + U+0308
const NFD_MUELLER = 'Müller'

function doc(...paragraphs: unknown[][]): TipTapDocument {
  return {
    type: 'doc',
    content: paragraphs.map((content) => ({ type: 'paragraph', content }))
  } as TipTapDocument
}

const DOC = doc(
  [speaker('Person A'), text(' '), time('00:00:05'), text(' Guten Tag, wie geht es?')],
  [
    speaker('Person B'),
    text(' '),
    time('00:00:09'),
    text(' Seit '),
    chip('Reto Fässler'),
    text(' 😀 plant, schlafe ich schlecht bei '),
    text(NFD_MUELLER),
    text(' in Bern.')
  ],
  [text('Ohne Original: '), chip('', 2, 'ORT'), text(' Ende.')]
)

let handle: TestEditorHandle | null = null
afterEach(() => {
  handle?.destroy()
  handle = null
})

function editorWith(content: TipTapDocument = DOC): TestEditorHandle {
  handle = createTestEditor(content)
  return handle
}

function paragraphPos(h: TestEditorHandle, index: number): number {
  let pos = -1
  h.editor.state.doc.forEach((_node, offset, i) => {
    if (i === index) pos = offset
  })
  return pos
}

/** Klartext an den abgebildeten Stücken (Chips mit ihrem Original). */
function textOf(h: TestEditorHandle, pieces: ReturnType<typeof mapTextRange>): string {
  return pieces
    .map((p) => {
      if (p.kind === 'inline') return h.editor.state.doc.textBetween(p.from, p.to)
      const node = h.editor.state.doc.nodeAt(p.from)
      return `[chip:${node?.attrs.original}]`
    })
    .join('')
}

describe('paragraphTextMap — dieselbe Zählung wie der Main-Prozess', () => {
  it('ergibt für jeden Absatz genau den Text von paragraphSearchText', () => {
    const h = editorWith()
    h.editor.state.doc.forEach((node, offset) => {
      expect(paragraphTextMap(node, offset).text).toBe(paragraphSearchText(node.toJSON()).text)
    })
  })

  it('zählt Chips mit dem Original, ohne Original mit dem Token, Sprecher und Zeit nicht', () => {
    const h = editorWith()
    const p1 = h.editor.state.doc.child(1)
    expect(paragraphTextMap(p1, paragraphPos(h, 1)).text).toBe(
      `  Seit Reto Fässler 😀 plant, schlafe ich schlecht bei ${NFD_MUELLER} in Bern.`
    )
    const p2 = h.editor.state.doc.child(2)
    expect(paragraphTextMap(p2, paragraphPos(h, 2)).text).toBe('Ohne Original: [ORT 2] Ende.')
  })
})

describe('mapTextRange', () => {
  function rangeFor(h: TestEditorHandle, index: number, needle: string) {
    const map = paragraphTextMap(h.editor.state.doc.child(index), paragraphPos(h, index))
    const s = map.text.indexOf(needle)
    expect(s).toBeGreaterThanOrEqual(0)
    return { map, s, e: s + needle.length }
  }

  it('bildet Text nach Sprecher-, Zeit-Knoten, Chip und Emoji exakt ab', () => {
    const h = editorWith()
    const { map, s, e } = rangeFor(h, 1, 'schlafe')
    expect(textOf(h, mapTextRange(map, s, e))).toBe('schlafe')
  })

  it('markiert einen Treffer in einem Chip als ganzen Chip (auch Teilwort)', () => {
    const h = editorWith()
    const { map, s, e } = rangeFor(h, 1, 'Fäss')
    const pieces = mapTextRange(map, s, e)
    expect(pieces).toHaveLength(1)
    expect(pieces[0].kind).toBe('node')
    expect(textOf(h, pieces)).toBe('[chip:Reto Fässler]')
  })

  it('teilt einen Bereich über Text und Chip in Stücke auf', () => {
    const h = editorWith()
    const { map, s, e } = rangeFor(h, 1, 'Seit Reto')
    expect(textOf(h, mapTextRange(map, s, e))).toBe('Seit [chip:Reto Fässler]')
  })

  it('zählt zerlegte Umlaute in UTF-16-Einheiten wie ProseMirror', () => {
    const h = editorWith()
    const { map, s, e } = rangeFor(h, 1, NFD_MUELLER)
    expect(textOf(h, mapTextRange(map, s, e))).toBe(NFD_MUELLER)
  })

  it('trifft den Platzhalter eines Chips ohne Original', () => {
    const h = editorWith()
    const { map, s, e } = rangeFor(h, 2, 'ORT')
    expect(mapTextRange(map, s, e)[0].kind).toBe('node')
  })
})

function hitFocus(
  h: TestEditorHandle,
  index: number,
  needle: string
): Extract<SearchFocus, { kind: 'hit' }> {
  const map = paragraphTextMap(h.editor.state.doc.child(index), paragraphPos(h, index))
  const s = map.text.indexOf(needle)
  return {
    kind: 'hit',
    paraFrom: index,
    paraTo: index,
    ranges: [{ p: index, s, e: s + needle.length }],
    anchor: map.text.slice(s, s + needle.length)
  }
}

describe('resolveSearchFocus — robust gegen Bearbeitung', () => {
  it('übernimmt Absätze und Bereiche, solange der Anker noch passt', () => {
    const h = editorWith()
    const resolved = resolveSearchFocus(h.editor.state.doc, hitFocus(h, 1, 'Bern'))
    expect(resolved.kind).toBe('body')
    if (resolved.kind !== 'body') return
    expect(resolved.relocated).toBe(false)
    expect(resolved.paragraphIndex).toBe(1)
    expect(resolved.spec.paragraphs).toHaveLength(1)
    expect(textOf(h, resolved.spec.marks)).toBe('Bern')
    expect(resolved.scrollParagraphPos).toBe(paragraphPos(h, 1))
  })

  it('findet die Stelle nach einer Bearbeitung über den Anker wieder (nächster Absatz)', () => {
    const h = editorWith()
    const focus = hitFocus(h, 1, 'Bern')
    // Zwei neue Absätze vorne: der Absatzindex stimmt nicht mehr
    h.editor.commands.insertContentAt(0, [
      { type: 'paragraph', content: [text('Neu eins.')] },
      { type: 'paragraph', content: [text('Neu zwei.')] }
    ])
    const resolved = resolveSearchFocus(h.editor.state.doc, focus)
    expect(resolved.kind).toBe('body')
    if (resolved.kind !== 'body') return
    expect(resolved.relocated).toBe(true)
    expect(resolved.paragraphIndex).toBe(3)
    expect(textOf(h, resolved.spec.marks)).toBe('Bern')
  })

  it('wählt bei mehreren Vorkommen den Absatz, der dem ursprünglichen am nächsten liegt', () => {
    const h = editorWith(
      doc([text('Angst vorne.')], [text('Mitte')], [text('Mitte')], [text('Angst hinten.')])
    )
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 3,
      paraTo: 3,
      ranges: [{ p: 3, s: 0, e: 4 }],
      anchor: 'Zorn'
    })
    // Anker «Zorn» fehlt → kein Treffer
    expect(resolved.kind).toBe('missing')
    const found = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 2,
      paraTo: 2,
      ranges: [{ p: 2, s: 0, e: 5 }],
      anchor: 'Angst'
    })
    expect(found.kind === 'body' && found.paragraphIndex).toBe(3)
  })

  it('Treffer aus einer früheren Fassung suchen gleich über den Anker (#212)', () => {
    const h = editorWith()
    // Bereich zeigt auf Absatz 0 (alte Fassung), der Anker steht in Absatz 1
    const focus = {
      kind: 'hit' as const,
      paraFrom: 0,
      paraTo: 0,
      ranges: [{ p: 0, s: 1, e: 5 }],
      anchor: 'Bern',
      fromEarlierVersion: true as const
    }
    const resolved = resolveSearchFocus(h.editor.state.doc, focus)
    expect(resolved.kind === 'body' && resolved.paragraphIndex).toBe(1)
    expect(resolved.kind === 'body' && resolved.relocated).toBe(true)
    if (resolved.kind === 'body') expect(textOf(h, resolved.spec.marks)).toBe('Bern')
  })

  it('meldet «missing», wenn es die Stelle nicht mehr gibt', () => {
    const h = editorWith()
    const focus = hitFocus(h, 1, 'Bern')
    h.editor.commands.setContent(doc([text('Alles neu geschrieben.')]))
    expect(resolveSearchFocus(h.editor.state.doc, focus)).toEqual({ kind: 'missing' })
  })

  it('Treffer nach Bedeutung: Anker als Anfang der Unit, nur Absatz hinterlegt', () => {
    const h = editorWith()
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 0,
      paraTo: 1,
      anchor: 'Seit Reto Fässler'
    })
    expect(resolved.kind === 'body' && resolved.spec.paragraphs.length).toBe(2)
    expect(resolved.kind === 'body' && resolved.spec.marks).toEqual([])
    expect(resolved.kind === 'body' && resolved.spec.style).toBe('semantic')
    // gescrollt wird zum ersten Absatz des Abschnitts
    expect(resolved.kind === 'body' && resolved.scrollParagraphPos).toBe(paragraphPos(h, 0))
    expect(resolved.kind === 'body' && resolved.paragraphIndex).toBe(0)
  })

  it('exakter Treffer über mehrere Absätze: nur Absätze mit einem markierten Begriff', () => {
    const h = editorWith()
    const inner = hitFocus(h, 1, 'Bern')
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      ...inner,
      paraFrom: 0,
      paraTo: 2
    })
    expect(resolved.kind).toBe('body')
    if (resolved.kind !== 'body') return
    expect(resolved.spec.style).toBe('exact')
    expect(resolved.spec.paragraphs).toEqual([{ from: paragraphPos(h, 1), to: paragraphPos(h, 2) }])
    expect(resolved.paragraphIndex).toBe(1)
    expect(resolved.scrollParagraphPos).toBe(paragraphPos(h, 1))
  })

  it('ein Begriff ausserhalb von paraFrom..paraTo: auch dieser Absatz ist hinterlegt', () => {
    const h = editorWith()
    const inRange = hitFocus(h, 1, 'Bern')
    const outside = hitFocus(h, 2, 'Ende')
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 1,
      paraTo: 1,
      ranges: [...inRange.ranges!, ...outside.ranges!],
      anchor: 'Bern'
    })
    expect(resolved.kind).toBe('body')
    if (resolved.kind !== 'body') return
    expect(resolved.spec.paragraphs.map((p) => p.from)).toEqual([
      paragraphPos(h, 1),
      paragraphPos(h, 2)
    ])
    expect(resolved.scrollParagraphPos).toBe(paragraphPos(h, 1))
  })

  it('exakte Begriffe in zwei Absätzen: beide hinterlegt, gescrollt zum ersten', () => {
    const h = editorWith()
    const a = hitFocus(h, 0, 'Guten')
    const b = hitFocus(h, 2, 'Ende')
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 0,
      paraTo: 2,
      ranges: [...a.ranges!, ...b.ranges!],
      anchor: 'Guten'
    })
    expect(resolved.kind).toBe('body')
    if (resolved.kind !== 'body') return
    expect(resolved.spec.paragraphs.map((p) => p.from)).toEqual([
      paragraphPos(h, 0),
      paragraphPos(h, 2)
    ])
    expect(resolved.scrollParagraphPos).toBe(paragraphPos(h, 0))
  })

  it('vergleicht den Anker ohne Rücksicht auf Gross-/Kleinschreibung und Umlaut-Schreibweise', () => {
    const h = editorWith()
    const focus = { ...hitFocus(h, 1, NFD_MUELLER), anchor: 'MUELLER' }
    const resolved = resolveSearchFocus(h.editor.state.doc, focus)
    expect(resolved.kind === 'body' && resolved.relocated).toBe(false)
  })

  it('Titel und Zusammenfassung führen zum jeweiligen Feld', () => {
    const h = editorWith()
    expect(resolveSearchFocus(h.editor.state.doc, { kind: 'title' })).toEqual({ kind: 'title' })
    expect(resolveSearchFocus(h.editor.state.doc, { kind: 'summary' })).toEqual({
      kind: 'summary'
    })
  })
})

describe('Plugin: nur Decorations', () => {
  function applyHit(h: TestEditorHandle, needle: string) {
    const resolved = resolveSearchFocus(h.editor.state.doc, hitFocus(h, 1, needle))
    if (resolved.kind !== 'body') throw new Error('keine Fundstelle')
    h.editor.view.dispatch(setSearchHighlight(h.editor.state, resolved.spec))
  }

  it('ändert das Dokument nicht, löst kein update aus und legt keinen Undo-Schritt an', () => {
    const h = editorWith()
    const onUpdate = vi.fn()
    h.editor.on('update', onUpdate)
    const before = h.editor.state.doc
    applyHit(h, 'Fäss')
    expect(h.editor.state.doc).toBe(before)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(hasSearchHighlight(h.editor.state)).toBe(true)
    expect(h.editor.can().undo()).toBe(false)
    // Auswahl unverändert: keine Textauswahl
    expect(h.editor.state.selection.empty).toBe(true)
  })

  it('hinterlegt den Absatz und markiert den Chip nur mit Klassen — kein Klarname im DOM-Attribut', () => {
    const h = editorWith()
    applyHit(h, 'Fäss')
    const dom = h.editor.view.dom
    const paragraph = dom.querySelector('p.search-hit-paragraph')
    expect(paragraph).not.toBeNull()
    const chipEl = dom.querySelector('.search-hit-chip') as HTMLElement
    expect(chipEl).not.toBeNull()
    // Pseudonymisierte Darstellung: der Chip zeigt den Platzhalter, die Markierung
    // fügt weder title noch aria-* mit dem Original hinzu
    for (const attr of Array.from(chipEl.attributes)) {
      expect(attr.value).not.toContain('Reto')
      expect(attr.value).not.toContain('Fässler')
    }
    expect(paragraph!.getAttribute('title')).toBeNull()
    expect(paragraph!.getAttribute('aria-label')).toBeNull()
  })

  it('Treffer nach Bedeutung: nur Randbalken-Klasse, keine vollflächige Hinterlegung', () => {
    const h = editorWith()
    const resolved = resolveSearchFocus(h.editor.state.doc, {
      kind: 'hit',
      paraFrom: 0,
      paraTo: 1,
      anchor: 'Guten Tag'
    })
    if (resolved.kind !== 'body') throw new Error('keine Fundstelle')
    h.editor.view.dispatch(setSearchHighlight(h.editor.state, resolved.spec))
    const dom = h.editor.view.dom
    expect(dom.querySelectorAll('p.search-hit-paragraph-semantic')).toHaveLength(2)
    expect(dom.querySelector('p.search-hit-paragraph')).toBeNull()
  })

  it('markiert exakte Begriffe als Inline-Decoration', () => {
    const h = editorWith()
    applyHit(h, 'schlafe')
    expect(h.editor.view.dom.querySelector('.search-hit-term')?.textContent).toBe('schlafe')
  })

  it('verschwindet bei der ersten Bearbeitung', () => {
    const h = editorWith()
    applyHit(h, 'Bern')
    h.insertText(2, 'x')
    expect(hasSearchHighlight(h.editor.state)).toBe(false)
  })

  it('lässt sich ohne Dokumentänderung wieder entfernen', () => {
    const h = editorWith()
    applyHit(h, 'Bern')
    h.editor.view.dispatch(setSearchHighlight(h.editor.state, null))
    expect(searchHighlightKey.getState(h.editor.state)?.find()).toEqual([])
  })
})
