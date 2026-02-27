import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EntityMap, PlaceholderType } from '../../../shared/types'
import {
  normalizeUmlaut,
  isWholeWord,
  normalizeWithPositionMap
} from '../../../shared/utils/blocklist-matching'

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

interface ExtendedSelection {
  from: number
  to: number
  originalText: string
}

/**
 * Auto-extend a selection range to include any overlapping chips,
 * then extract the original text (resolving chips to their original attribute).
 */
export function extendSelectionAndExtractText(
  state: EditorState,
  from: number,
  to: number
): ExtendedSelection {
  let extFrom = from
  let extTo = to

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'placeholderChip') {
      const nodeEnd = pos + node.nodeSize
      if (pos < to && nodeEnd > from) {
        if (pos < extFrom) extFrom = pos
        if (nodeEnd > extTo) extTo = nodeEnd
      }
    }
  })

  let originalText = ''
  state.doc.nodesBetween(extFrom, extTo, (node, pos) => {
    if (node.type.name === 'placeholderChip') {
      originalText += (node.attrs.original as string) || ''
    } else if (node.isText) {
      const start = Math.max(pos, extFrom) - pos
      const end = Math.min(pos + node.nodeSize, extTo) - pos
      originalText += (node.text ?? '').slice(start, end)
    }
  })

  return { from: extFrom, to: extTo, originalText }
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

  const extended = extendSelectionAndExtractText(state, from, to)
  if (!extended.originalText.trim()) return null

  const { from: extendedFrom, to: extendedTo, originalText } = extended

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

/**
 * Check whether the document contains any placeholderChip with the given entityId.
 */
export function hasChipsWithEntityId(doc: PMNode, entityId: string): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (node.type.name === 'placeholderChip' && node.attrs.entityId === entityId) {
      found = true
      return false
    }
    return true
  })
  return found
}

export interface BlocklistRetroactiveResult {
  entityMap: EntityMap
  entityId: string
}

/**
 * Add a term to the blocklist with retroactive application on the current document.
 *
 * 1. Replaces the current selection with a blocklist chip
 * 2. Scans all text nodes for additional matches (case-insensitive + Umlaut)
 * 3. Replaces all matches with chips of the same entityId
 * 4. All replacements happen in a single ProseMirror transaction = one undo step
 *
 * The term stored in the blocklist is the original text from the selection.
 *
 * Returns the updated entityMap + entityId, or null if no selection.
 */
export function addToBlocklistRetroactive(
  editor: Editor,
  term: string,
  type: PlaceholderType,
  entityMap: EntityMap
): BlocklistRetroactiveResult | null {
  const { state } = editor
  const { from, to, empty } = state.selection

  if (empty) return null

  const extended = extendSelectionAndExtractText(state, from, to)
  if (!extended.originalText.trim()) return null

  const { from: extFrom, to: extTo, originalText: selectionOriginal } = extended

  const number = getNextNumber(entityMap, type)
  const entityId = generateEntityId(type, number)

  // Collect all replacement positions
  const replacements: Array<{ from: number; to: number; original: string }> = []

  // 1. The initial selection
  replacements.push({ from: extFrom, to: extTo, original: selectionOriginal })

  // 2. Retroactive matches in text nodes
  const normalizedTerm = normalizeUmlaut(term.trim().toLowerCase())

  state.doc.descendants((node, pos) => {
    if (!node.isText) return

    const text = node.text!
    const { normalized, toOriginal } = normalizeWithPositionMap(text.toLowerCase())

    let searchStart = 0
    while (true) {
      const idx = normalized.indexOf(normalizedTerm, searchStart)
      if (idx === -1) break

      const origStart = toOriginal[idx]
      const origEnd = toOriginal[idx + normalizedTerm.length]
      const absStart = pos + origStart
      const absEnd = pos + origEnd

      if (isWholeWord(text, origStart, origEnd)) {
        // Skip if overlapping with the initial selection
        const overlapsSelection = absStart < extTo && absEnd > extFrom
        if (!overlapsSelection) {
          replacements.push({
            from: absStart,
            to: absEnd,
            original: text.substring(origStart, origEnd)
          })
        }
      }

      searchStart = idx + 1
    }
  })

  // Sort by position descending (replace from back to front)
  replacements.sort((a, b) => b.from - a.from)

  // Create all chips in a single transaction
  const { tr } = state
  for (const rep of replacements) {
    const chipNode = state.schema.nodes.placeholderChip.create({
      entityId,
      type,
      number,
      source: 'blocklist',
      original: rep.original
    })
    tr.replaceWith(rep.from, rep.to, chipNode)
  }

  editor.view.dispatch(tr)

  // Update entityMap
  const updated = { ...entityMap }
  updated[entityId] = {
    original: term.trim(),
    placeholder: `[${type} ${number}]`,
    type,
    source: 'blocklist'
  }

  return { entityMap: updated, entityId }
}
