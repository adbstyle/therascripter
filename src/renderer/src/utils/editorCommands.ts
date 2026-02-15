import type { Editor } from '@tiptap/core'
import type { EntityMap, PlaceholderType } from '../../../shared/types'

/**
 * Get the next available number for a placeholder type.
 * Scans the entityMap for the highest number of the given type and returns +1.
 * Gaps are NOT filled (Decision #140).
 */
export function getNextNumber(entityMap: EntityMap, type: PlaceholderType): number {
  let max = 0
  for (const entry of Object.values(entityMap)) {
    if (entry.type === type) {
      const num = parseInt(entry.placeholder.match(/\d+/)?.[0] ?? '0', 10)
      if (num > max) max = num
    }
  }
  return max + 1
}

/**
 * Generate a unique entityId for a new manual placeholder.
 * Format: "type-number" (e.g., "person-4").
 */
function generateEntityId(type: PlaceholderType, number: number): string {
  return `${type.toLowerCase()}-${number}`
}

/**
 * Batch-remove all placeholder chips with the given entityId.
 * Each chip is replaced by its original text.
 * All replacements happen in a single ProseMirror transaction = one undo step.
 *
 * Returns the updated entityMap (with the entry removed).
 */
export function batchRemovePlaceholder(
  editor: Editor,
  entityId: string,
  entityMap: EntityMap
): EntityMap {
  const { state } = editor
  const { tr } = state

  // Collect all positions with this entityId (reverse order for safe replacement)
  const positions: Array<{ pos: number; nodeSize: number; original: string }> = []

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'placeholderChip' && node.attrs.entityId === entityId) {
      positions.push({
        pos,
        nodeSize: node.nodeSize,
        original: node.attrs.original as string
      })
    }
  })

  // Replace in reverse order — higher positions first so lower positions stay valid
  positions.sort((a, b) => b.pos - a.pos)

  for (const { pos, nodeSize, original } of positions) {
    tr.replaceWith(pos, pos + nodeSize, state.schema.text(original))
  }

  if (positions.length > 0) {
    editor.view.dispatch(tr)
  }

  // Remove entry from entityMap
  const updated = { ...entityMap }
  delete updated[entityId]
  return updated
}

/**
 * Anonymize the current text selection by replacing it with a PlaceholderChip.
 * If the selection overlaps with existing chips, it auto-extends to include them.
 *
 * Returns the updated entityMap (with the new entry added), or null if no selection.
 */
export function anonymizeSelection(
  editor: Editor,
  type: PlaceholderType,
  entityMap: EntityMap
): EntityMap | null {
  const { state } = editor
  const { from, to, empty } = state.selection

  if (empty) return null

  // Auto-extend selection to include any chips that overlap with the selection range
  let extendedFrom = from
  let extendedTo = to

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'placeholderChip') {
      const nodeEnd = pos + node.nodeSize
      // Check if chip overlaps with selection
      if (pos < to && nodeEnd > from) {
        if (pos < extendedFrom) extendedFrom = pos
        if (nodeEnd > extendedTo) extendedTo = nodeEnd
      }
    }
  })

  // Extract the original text from the extended range
  const originalText = state.doc.textBetween(extendedFrom, extendedTo, '', '')

  if (!originalText.trim()) return null

  const number = getNextNumber(entityMap, type)
  const entityId = generateEntityId(type, number)

  // Create the chip node
  const chipNode = state.schema.nodes.placeholderChip.create({
    entityId,
    type,
    number,
    source: 'manual',
    original: originalText
  })

  // Replace the extended selection with the chip (single transaction)
  const { tr } = state
  tr.replaceWith(extendedFrom, extendedTo, chipNode)
  editor.view.dispatch(tr)

  // Add to entityMap
  const updated = { ...entityMap }
  updated[entityId] = {
    original: originalText,
    placeholder: `[${type} ${number}]`,
    type,
    source: 'manual'
  }

  return updated
}
