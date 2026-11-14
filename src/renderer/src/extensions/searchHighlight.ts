import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { formatPlaceholderToken } from '../../../shared/utils/formatPlaceholderToken'
import {
  findNormalizedRanges,
  normalizeSearchText,
  normalizeWithMap
} from '../../../shared/utils/search-normalize'
import type { PlaceholderType } from '../../../shared/types'
import type { SessionFocus } from '../navigation/routes'

/**
 * Fundstelle der Suche im Editor (#209 AK 11): reine Decorations — keine
 * Textauswahl, kein Dokument-Update, also weder Autosave noch eine neue
 * Aufbereitung für die Suche. Die Absätze der Fundstelle sind hinterlegt,
 * exakte Begriffe darin markiert; liegt ein Begriff (auch nur teilweise) in
 * einem Chip, ist der ganze Chip markiert. Das gilt in beiden Ansichten und
 * macht in der pseudonymisierten keinen Klarnamen sichtbar: die Markierung
 * setzt nur eine Klasse, nie Text, `title` oder `aria-*`.
 *
 * Die Bereiche kommen als Klartext-Offsets pro Absatz (`SearchParagraphRange`)
 * und werden hier nach derselben Regel wie `paragraphSearchText` im
 * Main-Prozess auf ProseMirror-Positionen abgebildet: Text zählt mit seiner
 * Länge (UTF-16, wie ProseMirror), ein Chip mit `original.length` bzw. ohne
 * Original mit seinem Platzhalter-Token, Sprecher- und Zeit-Knoten zählen nicht.
 *
 * Die Markierung verschwindet bei der ersten Bearbeitung (`docChanged`) bzw.
 * wenn der Editor sie löscht (erstes Scrollen des USERs, Prototyp).
 */

export const searchHighlightKey = new PluginKey<DecorationSet>('searchHighlight')

/** Ein Stück der Markierung: Text (inline) oder ein ganzer Chip (node). */
export interface HighlightPiece {
  kind: 'inline' | 'node'
  from: number
  to: number
}

export interface SearchHighlightSpec {
  /** Absätze als ganze hinterlegen: Positionen [from, to) der Absatz-Knoten. */
  paragraphs: Array<{ from: number; to: number }>
  marks: HighlightPiece[]
}

interface Segment {
  kind: 'text' | 'chip'
  /** Bereich im Klartext des Absatzes. */
  start: number
  end: number
  /** ProseMirror-Position des Knotens. */
  pos: number
  nodeSize: number
}

export interface ParagraphTextMap {
  /** Klartext ohne Sprecher- und Zeit-Knoten. */
  text: string
  segments: Segment[]
}

function chipText(node: PMNode): string {
  const original = node.attrs.original
  if (typeof original === 'string' && original.length > 0) return original
  const { type, number } = node.attrs
  if (type == null || number == null) return ''
  return formatPlaceholderToken({ type: type as PlaceholderType, number: number as number })
}

/**
 * Klartext eines Absatzes samt Positionstabelle. `paragraphPos` ist die
 * Position VOR dem Absatz-Knoten.
 */
export function paragraphTextMap(paragraph: PMNode, paragraphPos: number): ParagraphTextMap {
  const parts: string[] = []
  const segments: Segment[] = []
  let length = 0
  paragraph.forEach((child, offset) => {
    const pos = paragraphPos + 1 + offset
    let text = ''
    let kind: Segment['kind'] = 'text'
    if (child.isText) {
      text = child.text ?? ''
    } else if (child.type.name === 'placeholderChip') {
      text = chipText(child)
      kind = 'chip'
    } else if (child.type.name === 'speakerLabel' || child.type.name === 'timestamp') {
      return
    } else {
      // Unbekannte Inline-Knoten (z. B. hardBreak): Text ihrer Kinder
      text = child.textContent
      kind = 'chip'
    }
    if (text.length === 0) return
    segments.push({ kind, start: length, end: length + text.length, pos, nodeSize: child.nodeSize })
    parts.push(text)
    length += text.length
  })
  return { text: parts.join(''), segments }
}

/** Bildet `[s, e)` im Klartext eines Absatzes auf ProseMirror-Stücke ab. */
export function mapTextRange(map: ParagraphTextMap, s: number, e: number): HighlightPiece[] {
  const pieces: HighlightPiece[] = []
  if (e <= s) return pieces
  for (const seg of map.segments) {
    if (seg.end <= s || seg.start >= e) continue
    if (seg.kind === 'chip') {
      pieces.push({ kind: 'node', from: seg.pos, to: seg.pos + seg.nodeSize })
    } else {
      const from = seg.pos + Math.max(s, seg.start) - seg.start
      const to = seg.pos + Math.min(e, seg.end) - seg.start
      if (to > from) pieces.push({ kind: 'inline', from, to })
    }
  }
  return pieces
}

interface ParagraphInfo {
  index: number
  pos: number
  node: PMNode
}

function topLevelParagraphs(doc: PMNode): ParagraphInfo[] {
  const list: ParagraphInfo[] = []
  doc.forEach((node, offset, index) => list.push({ index, pos: offset, node }))
  return list
}

function sameText(a: string, b: string): boolean {
  return normalizeSearchText(a) === normalizeSearchText(b)
}

export type ResolvedFocus =
  | { kind: 'title' }
  | { kind: 'summary' }
  | {
      kind: 'body'
      spec: SearchHighlightSpec
      /** Position, an die gescrollt wird (Anfang der ersten Markierung bzw. des Absatzes). */
      scrollPos: number
      /** Position des Absatz-Knotens, der `scrollPos` enthält — er wird in die Mitte gescrollt. */
      scrollParagraphPos: number
      /** Index des ersten hinterlegten Absatzes (für die Ansage). */
      paragraphIndex: number
      paragraphCount: number
      /** Die Stelle wurde nach einer Bearbeitung wiedergefunden. */
      relocated: boolean
    }
  | { kind: 'missing' }

function bodyResult(
  paragraphs: ParagraphInfo[],
  from: number,
  to: number,
  marks: HighlightPiece[],
  relocated: boolean,
  total: number
): ResolvedFocus {
  const covered = paragraphs.slice(from, to + 1)
  const spec: SearchHighlightSpec = {
    paragraphs: covered.map((p) => ({ from: p.pos, to: p.pos + p.node.nodeSize })),
    marks
  }
  const first = marks.length > 0 ? Math.min(...marks.map((m) => m.from)) : covered[0].pos
  const holder =
    paragraphs.find((p) => p.pos <= first && first < p.pos + p.node.nodeSize) ?? covered[0]
  return {
    kind: 'body',
    spec,
    scrollPos: first,
    scrollParagraphPos: holder.pos,
    paragraphIndex: from,
    paragraphCount: total,
    relocated
  }
}

/**
 * Löst eine Fundstelle gegen das AKTUELLE Dokument auf (Bauplan 4, «robust
 * gegen Bearbeitung»):
 * 1. Stimmt die Stelle noch (der Text am ersten markierten Bereich ist der
 *    `anchor` bzw. ein Absatz der Fundstelle enthält ihn), gelten Absätze und
 *    Bereiche wie geliefert.
 * 2. Sonst: der `anchor` im aktuellen Dokument, nächster Treffer zum
 *    ursprünglichen Absatz.
 * 3. Gibt es keinen: `missing` — die Sitzung öffnet oben mit Hinweis.
 */
export function resolveSearchFocus(doc: PMNode, focus: SessionFocus): ResolvedFocus {
  if (focus.kind === 'title' || focus.kind === 'summary') return { kind: focus.kind }
  const paragraphs = topLevelParagraphs(doc)
  const total = paragraphs.length
  if (total === 0) return { kind: 'missing' }

  if (focus.kind === 'paragraph') {
    if (focus.index < 0 || focus.index >= total) return { kind: 'missing' }
    return bodyResult(paragraphs, focus.index, focus.index, [], false, total)
  }

  const maps = new Map<number, ParagraphTextMap>()
  const mapOf = (i: number): ParagraphTextMap => {
    let map = maps.get(i)
    if (!map) {
      map = paragraphTextMap(paragraphs[i].node, paragraphs[i].pos)
      maps.set(i, map)
    }
    return map
  }

  const inBounds = focus.paraFrom >= 0 && focus.paraTo >= focus.paraFrom && focus.paraTo < total
  const anchor = focus.anchor ?? ''
  const normalizedAnchor = normalizeSearchText(anchor).trim()

  if (inBounds) {
    const ranges = (focus.ranges ?? []).filter(
      (r) => r.p >= 0 && r.p < total && r.e > r.s && r.e <= mapOf(r.p).text.length
    )
    const allRangesKept = ranges.length === (focus.ranges ?? []).length
    let valid: boolean
    if (focus.ranges && focus.ranges.length > 0) {
      const first = ranges[0]
      valid =
        allRangesKept &&
        first !== undefined &&
        (normalizedAnchor.length === 0 ||
          ranges.some((r) => sameText(mapOf(r.p).text.slice(r.s, r.e), anchor)))
    } else {
      valid =
        normalizedAnchor.length === 0 ||
        paragraphs
          .slice(focus.paraFrom, focus.paraTo + 1)
          .some((p) => normalizeSearchText(mapOf(p.index).text).includes(normalizedAnchor))
    }
    if (valid) {
      const marks = ranges.flatMap((r) => mapTextRange(mapOf(r.p), r.s, r.e))
      return bodyResult(paragraphs, focus.paraFrom, focus.paraTo, marks, false, total)
    }
  }

  // Wiederfinden: nächster Absatz mit dem Anker zum ursprünglichen
  if (normalizedAnchor.length === 0) return { kind: 'missing' }
  const origin = Math.min(Math.max(focus.paraFrom, 0), total - 1)
  const order = paragraphs
    .map((p) => p.index)
    .sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin) || a - b)
  for (const i of order) {
    const map = mapOf(i)
    const found = findNormalizedRanges(normalizeWithMap(map.text), normalizedAnchor)
    if (found.length === 0) continue
    // Exakte Treffer markieren das Wort wieder; Treffer nach Bedeutung nur den Absatz
    const marks =
      focus.ranges && focus.ranges.length > 0 ? mapTextRange(map, found[0].start, found[0].end) : []
    return bodyResult(paragraphs, i, i, marks, true, total)
  }
  return { kind: 'missing' }
}

function buildDecorations(doc: PMNode, spec: SearchHighlightSpec): DecorationSet {
  const decorations: Decoration[] = []
  for (const p of spec.paragraphs) {
    decorations.push(
      Decoration.node(p.from, p.to, { class: 'search-hit-paragraph', 'data-search-hit': 'true' })
    )
  }
  for (const m of spec.marks) {
    if (m.kind === 'node') {
      decorations.push(Decoration.node(m.from, m.to, { class: 'search-hit-chip' }))
    } else {
      decorations.push(Decoration.inline(m.from, m.to, { class: 'search-hit-term' }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

/** Transaktion, die die Markierung setzt (spec) bzw. entfernt (null) — ohne Dokumentänderung. */
export function setSearchHighlight(
  state: EditorState,
  spec: SearchHighlightSpec | null
): Transaction {
  return state.tr.setMeta(searchHighlightKey, spec).setMeta('addToHistory', false)
}

export function searchHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: searchHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        const meta = tr.getMeta(searchHighlightKey) as SearchHighlightSpec | null | undefined
        if (meta !== undefined) {
          return meta === null ? DecorationSet.empty : buildDecorations(tr.doc, meta)
        }
        // Erste Bearbeitung: die Fundstelle gilt nicht mehr
        if (tr.docChanged) return DecorationSet.empty
        return previous
      }
    },
    props: {
      decorations(state) {
        return searchHighlightKey.getState(state)
      }
    }
  })
}

/** Hat der Editor gerade eine Markierung? */
export function hasSearchHighlight(state: EditorState): boolean {
  const set = searchHighlightKey.getState(state)
  return !!set && set !== DecorationSet.empty && set.find().length > 0
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [searchHighlightPlugin()]
  }
})
