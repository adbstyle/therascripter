import { findNormalizedRanges, normalizeWithMap } from '../../shared/utils/search-normalize'
import {
  SEARCH_ANCHOR_CHARS,
  SEARCH_SNIPPET_LEAD_CHARS,
  SEARCH_SNIPPET_MAX_CHARS
} from '../../shared/search-config'
import type {
  SearchFocus,
  SearchHit,
  SearchMark,
  SearchParagraphRange,
  SearchSnippet
} from '../../shared/types/Search'
import type { StoredChunk } from '../db/repositories/SearchIndexRepository'
import { unitTextSpans, type ChunkUnitRef } from './chunker'
import type { RankedHit } from './ranking'

/**
 * Ausschnitt und Fundstelle eines Treffers (#209 AK 9, AK 11). Alles im
 * Klartext: die Treffer werden im normalisierten Text gesucht und über
 * normalizeWithMap auf den Originaltext zurückgerechnet.
 */

interface UnitMatch {
  /** Bereich im Unit-Text. */
  start: number
  end: number
}

interface UnitWithText {
  unit: ChunkUnitRef | null
  text: string
  matches: UnitMatch[]
}

function unitsWithMatches(chunk: StoredChunk, terms: string[]): UnitWithText[] {
  return unitTextSpans(chunk).map(({ start, end, unit }) => {
    const text = chunk.text.slice(start, end)
    const normalized = normalizeWithMap(text)
    const matches = terms
      .flatMap((term) => findNormalizedRanges(normalized, term))
      .sort((a, b) => a.start - b.start || b.end - a.end)
    return { unit, text, matches: mergeOverlapping(matches) }
  })
}

function mergeOverlapping(ranges: UnitMatch[]): UnitMatch[] {
  const merged: UnitMatch[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/** Fensterbeginn auf einer Wortgrenze vor `pos`. */
function windowStart(text: string, pos: number): number {
  if (pos <= SEARCH_SNIPPET_LEAD_CHARS) return 0
  let start = pos - SEARCH_SNIPPET_LEAD_CHARS
  const space = text.indexOf(' ', start)
  if (space >= 0 && space < pos) start = space + 1
  return start
}

/** Fensterende auf einer Wortgrenze, höchstens SEARCH_SNIPPET_MAX_CHARS nach `start`. */
function windowEnd(text: string, start: number, minEnd: number): number {
  const limit = start + SEARCH_SNIPPET_MAX_CHARS
  if (limit >= text.length) return text.length
  const end = Math.max(minEnd, limit)
  const space = text.lastIndexOf(' ', end)
  return space > minEnd ? space : end
}

export function buildSnippet(text: string, matches: UnitMatch[]): SearchSnippet {
  const first = matches[0]
  const start = first ? windowStart(text, first.start) : 0
  const end = windowEnd(text, start, first ? first.end : 0)
  const marks: SearchMark[] = matches
    .filter((m) => m.start >= start && m.end <= end)
    .map((m) => ({ start: m.start - start, end: m.end - start }))
  return {
    text: text.slice(start, end),
    marks,
    truncatedStart: start > 0,
    truncatedEnd: end < text.length
  }
}

function dedupeRanges(ranges: SearchParagraphRange[]): SearchParagraphRange[] {
  const seen = new Set<string>()
  return ranges.filter((r) => {
    const key = `${r.p}:${r.s}:${r.e}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Baut einen Treffer für die Anzeige. `chunks` muss den besten Abschnitt des
 * Treffers (`primary`) enthalten; Absätze und Markierungen stammen von ihm. Bei Treffern nach
 * Bedeutung (PR S4) ist `terms` leer: dann Anfang des Abschnitts, ohne
 * Markierungen, Anker = Anfang der ersten Unit.
 */
export function buildHit(
  hit: RankedHit,
  chunks: ReadonlyMap<number, StoredChunk>,
  terms: string[]
): SearchHit | null {
  const primary = chunks.get(hit.primary.chunkId)
  if (!primary) return null
  const exactTerms = hit.kind === 'exact' ? terms : []
  const units = unitsWithMatches(primary, exactTerms)
  const shown = units.find((u) => u.matches.length > 0) ?? units[0]
  if (!shown) return null

  const label: SearchHit['label'] = {}
  if (shown.unit?.spk !== undefined) label.speaker = shown.unit.spk
  if (shown.unit?.ts !== undefined) label.timestamp = shown.unit.ts

  const firstMatch = shown.matches[0]
  const snippet = buildSnippet(shown.text, shown.matches)
  let focus: SearchFocus
  if (hit.field === 'title') focus = { kind: 'title' }
  else if (hit.field === 'summary') focus = { kind: 'summary' }
  else {
    const ranges: SearchParagraphRange[] = []
    for (const u of units) {
      if (!u.unit) continue
      for (const m of u.matches) {
        ranges.push({ p: u.unit.p, s: u.unit.s + m.start, e: u.unit.s + m.end })
      }
    }
    const anchor = firstMatch
      ? shown.text.slice(firstMatch.start, firstMatch.end)
      : shown.text.slice(0, SEARCH_ANCHOR_CHARS)
    focus = {
      kind: 'hit',
      paraFrom: hit.paraFrom ?? shown.unit?.p ?? 0,
      paraTo: hit.paraTo ?? shown.unit?.p ?? 0,
      anchor
    }
    const unique = dedupeRanges(ranges)
    if (unique.length > 0) focus.ranges = unique
  }

  return { field: hit.field, kind: hit.kind, label, snippet, focus }
}
