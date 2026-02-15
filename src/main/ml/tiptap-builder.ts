import type { EntityMap, PlaceholderType, TranscriptSegment } from '../../shared/types'
import type { MergedEntity } from '../../shared/types/NerTypes'
import type {
  TipTapDocument,
  TipTapParagraph,
  TipTapInlineNode
} from '../../shared/types/TipTapDocument'
import { findEntityId } from './entity-map-builder'

/**
 * Format seconds to HH:MM:SS timestamp string.
 */
function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

interface EntityOccurrence {
  start: number
  end: number
  entityId: string
  type: PlaceholderType
  number: number
  source: 'ner' | 'blocklist' | 'manual'
  original: string
}

/**
 * Find all entity occurrences in a segment text using the entityMap.
 * Matches are found by looking up each entity's original text (and coreference variants)
 * in the segment, respecting whole-word boundaries and umlaut normalization.
 */
function findEntityOccurrences(
  segmentText: string,
  segmentIndex: number,
  entityMap: EntityMap,
  allEntities: MergedEntity[]
): EntityOccurrence[] {
  const occurrences: EntityOccurrence[] = []

  // Collect all entities that occur in this segment
  const segmentEntities = allEntities.filter((e) => e.segmentIndex === segmentIndex)

  for (const entity of segmentEntities) {
    const entityId = findEntityId(entityMap, entity.text, entity.type, allEntities)
    if (!entityId) continue

    const entry = entityMap[entityId]
    if (!entry) continue

    const numberMatch = entityId.match(/-(\d+)$/)
    const number = numberMatch ? parseInt(numberMatch[1], 10) : 1

    occurrences.push({
      start: entity.charStart,
      end: entity.charEnd,
      entityId,
      type: entry.type,
      number,
      source: entry.source,
      original: segmentText.substring(entity.charStart, entity.charEnd)
    })
  }

  // Sort by position and remove overlaps (keep earlier/longer)
  occurrences.sort((a, b) => a.start - b.start)
  return removeOverlaps(occurrences)
}

function removeOverlaps(occurrences: EntityOccurrence[]): EntityOccurrence[] {
  const result: EntityOccurrence[] = []

  for (const occ of occurrences) {
    const overlaps = result.some((r) => r.start < occ.end && r.end > occ.start)
    if (!overlaps) {
      result.push(occ)
    }
  }

  return result
}

/**
 * Build the inline content nodes for a segment, replacing entity spans with placeholder chips.
 */
function buildInlineNodes(
  segmentText: string,
  occurrences: EntityOccurrence[]
): TipTapInlineNode[] {
  const nodes: TipTapInlineNode[] = []
  let cursor = 0

  for (const occ of occurrences) {
    // Add text before entity
    if (occ.start > cursor) {
      nodes.push({ type: 'text', text: segmentText.substring(cursor, occ.start) })
    }

    // Add placeholder chip
    nodes.push({
      type: 'placeholderChip',
      attrs: {
        entityId: occ.entityId,
        type: occ.type,
        number: occ.number,
        source: occ.source,
        original: occ.original
      }
    })

    cursor = occ.end
  }

  // Add remaining text
  if (cursor < segmentText.length) {
    nodes.push({ type: 'text', text: segmentText.substring(cursor) })
  }

  return nodes
}

/**
 * Build a TipTap document from transcript segments, entity map, and entity positions.
 *
 * Multi-speaker transcripts get speakerLabel + timestamp nodes at the start of each paragraph.
 * Single-speaker transcripts get no speaker labels (per spec).
 */
export function buildTipTapDocument(
  segments: TranscriptSegment[],
  entityMap: EntityMap,
  allEntities: MergedEntity[],
  speakerCount: number
): TipTapDocument {
  const paragraphs: TipTapParagraph[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const content: TipTapInlineNode[] = []

    // Add speaker label + timestamp (multi-speaker only)
    if (speakerCount > 1 && segment.speaker) {
      const letter = segment.speaker.replace('Person ', '')

      content.push({
        type: 'timestamp',
        attrs: {
          seconds: segment.start,
          formatted: formatTimestamp(segment.start)
        }
      })

      content.push({ type: 'text', text: ' ' })

      content.push({
        type: 'speakerLabel',
        attrs: {
          speaker: letter,
          label: segment.speaker
        }
      })

      content.push({ type: 'text', text: ' ' })
    }

    // Find entities in this segment and build inline nodes
    const occurrences = findEntityOccurrences(segment.text, i, entityMap, allEntities)
    const textNodes = buildInlineNodes(segment.text, occurrences)
    content.push(...textNodes)

    // Only add paragraph if it has content
    if (content.length > 0) {
      paragraphs.push({ type: 'paragraph', content })
    }
  }

  // Ensure at least one empty paragraph
  if (paragraphs.length === 0) {
    paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: '' }] })
  }

  return { type: 'doc', content: paragraphs }
}
