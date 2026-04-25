import type { PlaceholderType, TranscriptSegment } from '../../shared/types'
import type {
  NerEntity,
  RegexEntity,
  MergedEntity,
  BlocklistEntry,
  NerBackend
} from '../../shared/types/NerTypes'
import { mapRegexTypeToPlaceholder } from './regex-patterns'
import {
  normalizeUmlaut,
  isWholeWord,
  normalizeWithPositionMap
} from '../../shared/utils/blocklist-matching'

// Re-export shared utilities for existing consumers
export { normalizeUmlaut, isWholeWord }

/** Map flair native type → canonical PlaceholderType. ORG ignored per Decision #5/#158. */
export function mapFlairType(nativeType: string): PlaceholderType | null {
  switch (nativeType) {
    case 'PER':
      return 'PERSON'
    case 'LOC':
      return 'ORT'
    case 'MISC':
      return 'SONSTIGES'
    case 'ORG':
      return null
    default:
      return null
  }
}

/**
 * Backend-aware mapping from native NER entity type to canonical PlaceholderType.
 * Returns `null` for types that should be filtered out (e.g. ORG, non-PII).
 *
 * `gliner` and `ai4privacy` are accepted as discriminator values but have no
 * canonical mapper yet — entities from those backends are dropped with a
 * `console.warn` rather than being mis-mapped through flair semantics
 * (different label vocabularies make a fall-through unsafe).
 */
export function mapNativeType(
  backend: NerBackend,
  nativeType: string
): PlaceholderType | null {
  switch (backend) {
    case 'flair':
      return mapFlairType(nativeType)
    case 'gliner':
    case 'ai4privacy':
      console.warn(
        `[entity-merger] mapNativeType called for backend "${backend}" but no mapper is implemented — dropping entity "${nativeType}"`
      )
      return null
  }
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
 *
 * `nerBackend` discriminates how native NER types translate to canonical types.
 * Defaults to 'flair'.
 */
export function mergeEntities(
  nerEntities: NerEntity[],
  regexEntities: RegexEntity[],
  blocklistEntries: BlocklistEntry[],
  segments: TranscriptSegment[],
  nerBackend: NerBackend = 'flair'
): MergedEntity[] {
  const merged: MergedEntity[] = []

  // 1. NER entities (highest priority)
  for (const entity of nerEntities) {
    const placeholderType = mapNativeType(nerBackend, entity.type)
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
