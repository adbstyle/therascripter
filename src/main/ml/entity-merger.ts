import type { PlaceholderType, TranscriptSegment } from '../../shared/types'
import type {
  NerEntity,
  RegexEntity,
  MergedEntity,
  BlocklistEntry
} from '../../shared/types/NerTypes'
import { mapRegexTypeToPlaceholder } from './regex-patterns'

/** Map flair NER type to Therascript placeholder type */
function mapNerType(nerType: string): PlaceholderType | null {
  switch (nerType) {
    case 'PER':
      return 'PERSON'
    case 'LOC':
      return 'ORT'
    case 'MISC':
      return 'SONSTIGES'
    case 'ORG':
      // ORG entities are IGNORED per Decision #5/#158
      return null
    default:
      return null
  }
}

/**
 * Bidirectional Umlaut normalization for matching.
 * Both sides (text + search term) are normalized to the same form.
 * ü→ue, ä→ae, ö→oe, ß→ss
 */
export function normalizeUmlaut(text: string): string {
  return text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
}

/**
 * Check if a match at [start, end) falls on word boundaries.
 * Prevents "Müller" from matching inside "Müllerstrasse".
 */
export function isWholeWord(text: string, start: number, end: number): boolean {
  const wordBoundary = /[\s.,;:!?()[\]{}"'/\-—–\n\r\t]/
  const before = start === 0 || wordBoundary.test(text[start - 1])
  const after = end >= text.length || wordBoundary.test(text[end])
  return before && after
}

/** Check if a new span [start, end) overlaps with any existing entity in the same segment */
function overlapsWithExisting(
  entities: MergedEntity[],
  segmentIndex: number,
  start: number,
  end: number
): boolean {
  return entities.some(
    (e) => e.segmentIndex === segmentIndex && e.charStart < end && e.charEnd > start
  )
}

/**
 * Merge NER, Regex, and Blocklist entities with priority: NER > Blocklist > Regex.
 * - ORG entities from NER are ignored (Decision #5/#158)
 * - Whole-word boundary check applied to all
 * - Overlapping entities are skipped (first-come wins by priority)
 */
export function mergeEntities(
  nerEntities: NerEntity[],
  regexEntities: RegexEntity[],
  blocklistEntries: BlocklistEntry[],
  segments: TranscriptSegment[]
): MergedEntity[] {
  const merged: MergedEntity[] = []

  // 1. NER entities (highest priority)
  for (const entity of nerEntities) {
    const placeholderType = mapNerType(entity.type)
    if (!placeholderType) continue // Skip ORG and unknown types

    const segText = segments[entity.segmentIndex]?.text
    if (!segText) continue

    if (!isWholeWord(segText, entity.charStart, entity.charEnd)) continue

    merged.push({
      text: entity.text,
      type: placeholderType,
      source: 'ner',
      segmentIndex: entity.segmentIndex,
      charStart: entity.charStart,
      charEnd: entity.charEnd
    })
  }

  // 2. Blocklist entries (supplements NER)
  for (const entry of sortByLengthDesc(blocklistEntries)) {
    const normalizedTerm = normalizeUmlaut(entry.term.toLowerCase())

    for (let i = 0; i < segments.length; i++) {
      const text = segments[i].text
      const { normalized, toOriginal } = normalizeWithPositionMap(text.toLowerCase())

      // Find all occurrences
      let searchStart = 0
      while (true) {
        const idx = normalized.indexOf(normalizedTerm, searchStart)
        if (idx === -1) break

        // Map normalized positions back to original text positions
        const origStart = toOriginal[idx]
        const origEnd = toOriginal[idx + normalizedTerm.length]

        if (
          isWholeWord(text, origStart, origEnd) &&
          !overlapsWithExisting(merged, i, origStart, origEnd)
        ) {
          merged.push({
            text: text.substring(origStart, origEnd),
            type: entry.placeholderType,
            source: 'blocklist',
            segmentIndex: i,
            charStart: origStart,
            charEnd: origEnd
          })
        }

        searchStart = idx + 1
      }
    }
  }

  // 3. Regex entities (lowest priority)
  for (const entity of regexEntities) {
    if (overlapsWithExisting(merged, entity.segmentIndex, entity.charStart, entity.charEnd)) {
      continue
    }

    merged.push({
      text: entity.text,
      type: mapRegexTypeToPlaceholder(entity.regexType),
      source: 'ner', // Regex is also automatic detection
      segmentIndex: entity.segmentIndex,
      charStart: entity.charStart,
      charEnd: entity.charEnd
    })
  }

  // Sort by segment index, then char position
  merged.sort((a, b) => {
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
    return a.charStart - b.charStart
  })

  return merged
}

/** Sort blocklist entries by term length (longest first) for longest-match-first */
function sortByLengthDesc(entries: BlocklistEntry[]): BlocklistEntry[] {
  return [...entries].sort((a, b) => b.term.length - a.term.length)
}

interface NormalizedWithMap {
  normalized: string
  toOriginal: number[] // normalizedPos → originalPos (includes sentinel at end)
}

/**
 * Normalize text for umlaut matching while building a position map
 * from normalized positions back to original positions.
 * This handles the length change when ü→ue, ä→ae, ö→oe, ß→ss.
 */
function normalizeWithPositionMap(text: string): NormalizedWithMap {
  const parts: string[] = []
  const toOriginal: number[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    let replacement: string
    switch (ch) {
      case 'ä':
        replacement = 'ae'
        break
      case 'ö':
        replacement = 'oe'
        break
      case 'ü':
        replacement = 'ue'
        break
      case 'ß':
        replacement = 'ss'
        break
      default:
        replacement = ch
        break
    }
    for (let j = 0; j < replacement.length; j++) {
      toOriginal.push(i)
    }
    parts.push(replacement)
  }
  // Sentinel: position after last char maps to original text length
  toOriginal.push(text.length)

  return { normalized: parts.join(''), toOriginal }
}
