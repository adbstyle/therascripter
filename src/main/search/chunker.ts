import { tiptapNodeToText, type TipTapTextOptions } from '../../shared/utils/tiptapToText'
import {
  SEARCH_MAX_OVERLAP_WORDS,
  SEARCH_MAX_UNIT_WORDS,
  SEARCH_TARGET_WORDS
} from '../../shared/search-config'
import type { SessionType } from '../../shared/types'
import type { SearchField } from '../../shared/types/Search'

/**
 * Abschnittsbildung der Suche (#209, Bauplan Abschnitt 4) — Port von
 * `split_turn`, `build_units` und `build_chunks` aus `scripts/search-spike.py`
 * (Spike #208), auf dem der Zielwert der Trefferqualität gemessen wurde.
 *
 * - Eine Unit ist ein Absatz von `doc.content` (bei Audio ein Sprecherbeitrag).
 *   Units über SEARCH_MAX_UNIT_WORDS Wörter werden an Satzgrenzen geteilt, ein
 *   Satz ohne Satzzeichen darüber an Wortgrenzen.
 * - Abschnitte sammeln Units bis ~SEARCH_TARGET_WORDS Wörter; die letzte Unit
 *   eines Abschnitts wird im nächsten wiederholt, wenn sie kurz ist.
 * - Abschnittstext: je Unit eine Zeile «Sprecher N: …» (Audio, nummeriert nach
 *   erstem Auftreten) bzw. «Bericht: …» (PDF) — so wie im Spike gemessen.
 *
 * Gezählt wird der Klartext: ein Chip zählt mit seinem `original`, ohne
 * Original mit seinem Platzhalter-Token (wie `tiptapToText`, chips 'original').
 * Sprecher- und Zeit-Knoten zählen nicht.
 *
 * Einzige bewusste Abweichung vom Spike: Der Text einer geteilten Unit ist der
 * Originalausschnitt vom ersten bis zum letzten Wort; der Spike fügt die Wörter
 * mit genau einem Leerzeichen neu zusammen. Bei einfachen Leerzeichen (der
 * Normalfall) ist beides gleich; so bleibt `[s, e)` exakt auf den Absatz
 * abbildbar. Der Paritätstest (`__tests__/chunker.parity.test.ts`) belegt die
 * Gleichheit auf eigenen Dokumenten und, sobald vorhanden, dem Referenz-Set.
 */

/** Wie der Spike: `(?<=[.!?…])\s+` trennt Sätze. */
const SENTENCE_END = /[.!?…]$/
const WORD = /\S+/g

const TEXT_OPTIONS: TipTapTextOptions = {
  includeSpeakers: false,
  includeTimestamps: false,
  compact: false,
  chips: 'original'
}

export interface SearchUnit {
  /** Index des Absatzes in `doc.content`. */
  p: number
  /** Bereich `[s, e)` im Klartext des Absatzes (ohne Sprecher-/Zeit-Knoten). */
  s: number
  e: number
  text: string
  words: number
  /** Präfix im Abschnittstext («Sprecher 1», «Bericht»), null = keins. */
  speaker: string | null
  /** Sprecher, wie das Dokument ihn anzeigt («Person A»). */
  spk?: string
  /** Zeitmarke des Absatzes («00:12:03»). */
  ts?: string
}

/** Positionsangabe einer Unit in `search_chunks.units` (JSON). */
export interface ChunkUnitRef {
  p: number
  s: number
  e: number
  /** Offset der Zeile im Abschnittstext. */
  o: number
  /** Länge des Präfixes («Sprecher 1: ») vor dem Unit-Text. */
  pfx: number
  spk?: string
  ts?: string
}

export interface SearchSection {
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  units: ChunkUnitRef[]
  text: string
}

interface JsonNode {
  type?: unknown
  attrs?: unknown
  content?: unknown
}

function asNode(value: unknown): JsonNode | null {
  return typeof value === 'object' && value !== null ? (value as JsonNode) : null
}

function attrsOf(node: JsonNode): Record<string, unknown> {
  return (asNode(node.attrs) ?? {}) as Record<string, unknown>
}

function childrenOf(node: JsonNode | null): unknown[] {
  return node && Array.isArray(node.content) ? node.content : []
}

export interface ParagraphText {
  /** Klartext ohne Sprecher- und Zeit-Knoten (Basis aller Offsets). */
  text: string
  /** `attrs.speaker` des ersten Sprecher-Knotens (Nummerierung). */
  speakerKey?: string
  /** `attrs.label` des ersten Sprecher-Knotens. */
  speakerLabel?: string
  timestamp?: string
}

/**
 * Klartext eines Absatzes, wie die Suche ihn zählt. Der Renderer bildet
 * Bereiche nach derselben Regel auf ProseMirror-Positionen ab (PR S5).
 */
export function paragraphSearchText(paragraph: unknown): ParagraphText {
  const node = asNode(paragraph)
  const result: ParagraphText = { text: '' }
  if (!node) return result
  if (node.type !== 'paragraph') {
    result.text = tiptapNodeToText(node, TEXT_OPTIONS)
    return result
  }
  const parts: string[] = []
  for (const raw of childrenOf(node)) {
    const child = asNode(raw)
    if (!child) continue
    if (child.type === 'speakerLabel') {
      const attrs = attrsOf(child)
      if (result.speakerKey === undefined) {
        const key = attrs.speaker ?? attrs.label
        if (key != null) result.speakerKey = String(key)
        if (attrs.label != null) result.speakerLabel = String(attrs.label)
      }
      continue
    }
    if (child.type === 'timestamp') {
      const formatted = attrsOf(child).formatted
      if (result.timestamp === undefined && formatted != null) result.timestamp = String(formatted)
      continue
    }
    parts.push(tiptapNodeToText(child, TEXT_OPTIONS))
  }
  result.text = parts.join('')
  return result
}

interface WordPos {
  s: number
  e: number
  sentenceEnd: boolean
}

function wordsOf(text: string): WordPos[] {
  const words: WordPos[] = []
  for (const m of text.matchAll(WORD)) {
    const s = m.index ?? 0
    words.push({ s, e: s + m[0].length, sentenceEnd: SENTENCE_END.test(m[0]) })
  }
  return words
}

/** Port von `split_turn`: Bereiche `[s, e)` der Teile eines Absatztexts. */
export function splitTurn(text: string, maxWords = SEARCH_MAX_UNIT_WORDS): Array<[number, number]> {
  const words = wordsOf(text)
  if (words.length === 0) return []
  if (words.length <= maxWords) return [[words[0].s, words[words.length - 1].e]]

  // Sätze als Wort-Indexbereiche, überlange Sätze an Wortgrenzen geteilt
  const sentences: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i < words.length; i++) {
    if (words[i].sentenceEnd || i === words.length - 1) {
      for (let j = start; j <= i; j += maxWords) sentences.push([j, Math.min(j + maxWords, i + 1)])
      start = i + 1
    }
  }

  const pieces: Array<[number, number]> = []
  let first = -1
  let last = -1
  let count = 0
  for (const [a, b] of sentences) {
    const n = b - a
    if (first >= 0 && count + n > maxWords) {
      pieces.push([words[first].s, words[last].e])
      first = -1
      count = 0
    }
    if (first < 0) first = a
    last = b - 1
    count += n
  }
  if (first >= 0) pieces.push([words[first].s, words[last].e])
  return pieces
}

/** Port von `build_units` für ein TipTap-Dokument. */
export function buildUnits(doc: unknown, type: SessionType): SearchUnit[] {
  const units: SearchUnit[] = []
  const speakerOrder = new Map<string, number>()
  const paragraphs = childrenOf(asNode(doc))
  paragraphs.forEach((paragraph, p) => {
    const para = paragraphSearchText(paragraph)
    let speaker: string | null = null
    if (type === 'pdf') {
      speaker = 'Bericht'
    } else if (para.speakerKey !== undefined) {
      if (!speakerOrder.has(para.speakerKey)) {
        speakerOrder.set(para.speakerKey, speakerOrder.size + 1)
      }
      speaker = `Sprecher ${speakerOrder.get(para.speakerKey)}`
    }
    for (const [s, e] of splitTurn(para.text)) {
      const text = para.text.slice(s, e)
      const unit: SearchUnit = { p, s, e, text, words: wordsOf(text).length, speaker }
      if (para.speakerLabel !== undefined) unit.spk = para.speakerLabel
      if (para.timestamp !== undefined) unit.ts = para.timestamp
      units.push(unit)
    }
  })
  return units
}

export interface UnitChunk {
  units: SearchUnit[]
  words: number
}

/** Port von `build_chunks` für die Units eines Dokuments. */
export function buildChunks(units: SearchUnit[], targetWords = SEARCH_TARGET_WORDS): UnitChunk[] {
  const chunks: UnitChunk[] = []
  let i = 0
  let carry: SearchUnit | null = null
  while (i < units.length) {
    const members: SearchUnit[] = carry ? [carry] : []
    let words = carry ? carry.words : 0
    let added = 0
    while (i < units.length && (words < targetWords || added === 0)) {
      members.push(units[i])
      words += units[i].words
      i++
      added++
    }
    chunks.push({ units: members, words })
    const last = members[members.length - 1]
    carry = last.words <= SEARCH_MAX_OVERLAP_WORDS && i < units.length ? last : null
  }
  return chunks
}

function toSection(chunk: UnitChunk, ord: number): SearchSection {
  const lines: string[] = []
  const refs: ChunkUnitRef[] = []
  let offset = 0
  for (const unit of chunk.units) {
    const prefix = unit.speaker ? `${unit.speaker}: ` : ''
    const ref: ChunkUnitRef = { p: unit.p, s: unit.s, e: unit.e, o: offset, pfx: prefix.length }
    if (unit.spk !== undefined) ref.spk = unit.spk
    if (unit.ts !== undefined) ref.ts = unit.ts
    refs.push(ref)
    const line = prefix + unit.text
    lines.push(line)
    offset += line.length + 1
  }
  const ps = chunk.units.map((u) => u.p)
  return {
    field: 'body',
    ord,
    paraFrom: Math.min(...ps),
    paraTo: Math.max(...ps),
    units: refs,
    text: lines.join('\n')
  }
}

export interface SessionSearchSource {
  type: SessionType
  /** Titel im Klartext; leer → kein Abschnitt. */
  title: string
  /** Zusammenfassung im Klartext; null/leer → kein Abschnitt. */
  summary: string | null
  /** TipTap-Dokument (unvalidiertes JSON); null → keine Text-Abschnitte. */
  document: unknown
}

/**
 * Alle Abschnitte einer Sitzung: Titel und Zusammenfassung als je ein eigener
 * Abschnitt (#209 AK 5), danach die Abschnitte des Texts.
 */
export function buildSearchSections(source: SessionSearchSource): SearchSection[] {
  const sections: SearchSection[] = []
  const title = source.title.trim()
  if (title.length > 0) {
    sections.push({ field: 'title', ord: 0, paraFrom: null, paraTo: null, units: [], text: title })
  }
  const summary = source.summary?.trim() ?? ''
  if (summary.length > 0) {
    sections.push({
      field: 'summary',
      ord: 0,
      paraFrom: null,
      paraTo: null,
      units: [],
      text: summary
    })
  }
  if (source.document != null) {
    buildChunks(buildUnits(source.document, source.type)).forEach((chunk, ord) =>
      sections.push(toSection(chunk, ord))
    )
  }
  return sections
}

/**
 * Text einer Unit im Abschnittstext — ohne Präfix. Für Titel und
 * Zusammenfassung (ohne Units) ist der ganze Abschnitt eine Unit.
 */
export function unitTextSpans(
  section: Pick<SearchSection, 'units' | 'text'>
): Array<{ start: number; end: number; unit: ChunkUnitRef | null }> {
  if (section.units.length === 0) return [{ start: 0, end: section.text.length, unit: null }]
  return section.units.map((unit) => {
    const start = unit.o + unit.pfx
    return { start, end: start + (unit.e - unit.s), unit }
  })
}

/**
 * Was der Trigramm-Index sieht: nur die Unit-Texte (ohne «Sprecher N:»,
 * sonst träfe die Anfrage «sprecher» jeden Abschnitt), je Unit eine Zeile.
 */
export function sectionIndexText(section: Pick<SearchSection, 'units' | 'text'>): string {
  return unitTextSpans(section)
    .map(({ start, end }) => section.text.slice(start, end))
    .join('\n')
}

/**
 * Was das Suchmodell sieht: der ganze Abschnittstext MIT «Sprecher N: …»
 * bzw. «Bericht: …» je Unit — genau so wurde der Zielwert der
 * Trefferqualität im Spike gemessen (`build_chunks` in search-spike.py:
 * `"\n".join(f"{speaker}: {text}")`, eingebettet mit dem Dokument-Prompt).
 * Anders als der Trigramm-Index (`sectionIndexText`), der die Präfixe
 * weglässt. Den Dokument-Prompt setzt der Suchdienst davor.
 */
export function sectionEmbeddingText(section: Pick<SearchSection, 'text'>): string {
  return section.text
}
