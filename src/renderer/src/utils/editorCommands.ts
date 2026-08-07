import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EntityMap, EntitySource, PlaceholderType } from '../../../shared/types'
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

interface CollectOptions {
  excludeRange: { from: number; to: number }
  overwritesChips: boolean
}

interface OccurrenceHit {
  from: number
  to: number
  original: string
  overwrittenChip?: { entityId: string; oldOriginal: string; oldSource: string }
}

/**
 * Scan the document for occurrences of `term` (case-insensitive, umlaut-normalized,
 * whole-word). Pass A walks text nodes; Pass B walks placeholderChip nodes (only
 * when opts.overwritesChips is true) and reports their entityId for orphan
 * cleanup by the caller. Hits overlapping opts.excludeRange are skipped.
 */
function collectIdenticalOccurrences(
  state: EditorState,
  term: string,
  opts: CollectOptions
): OccurrenceHit[] {
  const normalizedTerm = normalizeUmlaut(term.trim().toLowerCase())
  if (!normalizedTerm) return []

  const { from: excludeFrom, to: excludeTo } = opts.excludeRange
  const hits: OccurrenceHit[] = []

  state.doc.descendants((node, pos) => {
    // Pass A: text nodes
    if (node.isText) {
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
          const overlapsExclude = absStart < excludeTo && absEnd > excludeFrom
          if (!overlapsExclude) {
            hits.push({
              from: absStart,
              to: absEnd,
              original: text.substring(origStart, origEnd)
            })
          }
        }

        searchStart = idx + 1
      }
      return
    }

    // Pass B: chip nodes
    if (opts.overwritesChips && node.type.name === 'placeholderChip') {
      const chipOriginal = (node.attrs.original as string) ?? ''
      if (!chipOriginal) return
      if (normalizeUmlaut(chipOriginal.toLowerCase()) !== normalizedTerm) return

      const absStart = pos
      const absEnd = pos + node.nodeSize
      const overlapsExclude = absStart < excludeTo && absEnd > excludeFrom
      if (overlapsExclude) return

      hits.push({
        from: absStart,
        to: absEnd,
        original: chipOriginal,
        overwrittenChip: {
          entityId: node.attrs.entityId as string,
          oldOriginal: chipOriginal,
          oldSource: node.attrs.source as string
        }
      })
    }
  })

  return hits
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

  const hits = collectIdenticalOccurrences(state, term, {
    excludeRange: { from: extFrom, to: extTo },
    overwritesChips: false
  })

  const replacements: Array<{ from: number; to: number; original: string }> = [
    { from: extFrom, to: extTo, original: selectionOriginal },
    ...hits.map(({ from: f, to: t, original }) => ({ from: f, to: t, original }))
  ]

  replacements.sort((a, b) => b.from - a.from)

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

  const updated = { ...entityMap }
  updated[entityId] = {
    original: term.trim(),
    placeholder: `[${type} ${number}]`,
    type,
    source: 'blocklist'
  }

  return { entityMap: updated, entityId }
}

/**
 * Doc-wide blocklist application that does not require a selection. Used by the
 * chip action menu's "Zur Sperrliste hinzufügen". Allocates a fresh blocklist
 * entityId of `type`, then writes a single transaction that replaces every
 * occurrence of `term` — both text matches AND existing chips whose `original`
 * matches (case-insensitive + Umlaut + whole-word) — with chips of the new
 * entityId. Returns null if `term` is empty/whitespace or the doc has no match.
 */
export function addToBlocklistFromTerm(
  editor: Editor,
  term: string,
  type: PlaceholderType,
  entityMap: EntityMap
): BlocklistRetroactiveResult | null {
  const trimmed = term.trim()
  if (!trimmed) return null

  const { state } = editor
  const hits = collectIdenticalOccurrences(state, term, {
    excludeRange: { from: -1, to: -1 },
    overwritesChips: true
  })

  if (hits.length === 0) return null

  const number = getNextNumber(entityMap, type)
  const entityId = generateEntityId(type, number)

  const replacements = hits
    .map(({ from: f, to: t, original }) => ({ from: f, to: t, original }))
    .sort((a, b) => b.from - a.from)

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

  const updated = { ...entityMap }
  updated[entityId] = {
    original: trimmed,
    placeholder: `[${type} ${number}]`,
    type,
    source: 'blocklist'
  }

  return { entityMap: updated, entityId }
}

export interface ChangeChipTypeResult {
  entityMap: EntityMap
  /** New entityId assigned to all rewritten chips. */
  entityId: string
  /** Number of chips rewritten in the transaction. */
  rewrittenCount: number
}

/**
 * Change the type of every chip with `entityId` to `newType`. Allocates a fresh
 * entityId of the new type with `getNextNumber`, preserves each chip's original
 * `source` and `original` text by default, and replaces all chips in a single
 * transaction (one undo step). Returns null when the target type equals the
 * current type (silent no-op) or when no chips exist for `entityId`.
 *
 * Unlike `anonymizeSelectionWithPropagation`, this does NOT propagate to plain
 * text matches — only chips that already share the entityId are rewritten.
 *
 * `sourceOverride` lets the caller force every rewritten chip to a single source
 * — used when the type-change invalidates the original source semantics (e.g.
 * a blocklist-sourced chip whose backing SQLite row no longer matches the new
 * type, so the chips are downgraded to `'manual'`).
 */
export function changeChipTypeForEntity(
  editor: Editor,
  entityId: string,
  newType: PlaceholderType,
  entityMap: EntityMap,
  sourceOverride?: EntitySource
): ChangeChipTypeResult | null {
  const { state } = editor

  const targets: Array<{ pos: number; nodeSize: number; original: string; source: EntitySource }> =
    []
  let currentType: PlaceholderType | null = null
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'placeholderChip' && node.attrs.entityId === entityId) {
      if (currentType === null) currentType = node.attrs.type as PlaceholderType
      targets.push({
        pos,
        nodeSize: node.nodeSize,
        original: (node.attrs.original as string) ?? '',
        source: ((node.attrs.source as EntitySource) ?? 'manual') as EntitySource
      })
    }
  })

  if (targets.length === 0) return null
  if (currentType === newType) return null

  const newNumber = getNextNumber(entityMap, newType)
  const newEntityId = generateEntityId(newType, newNumber)

  // Reverse order so earlier positions stay valid as we replace.
  targets.sort((a, b) => b.pos - a.pos)

  const { tr } = state
  for (const target of targets) {
    const chipNode = state.schema.nodes.placeholderChip.create({
      entityId: newEntityId,
      type: newType,
      number: newNumber,
      source: sourceOverride ?? target.source,
      original: target.original
    })
    tr.replaceWith(target.pos, target.pos + target.nodeSize, chipNode)
  }

  editor.view.dispatch(tr)

  // Representative original = earliest chip in doc order (last item after the
  // reverse-sort above). entityMap.original is descriptive metadata only.
  const representative = targets[targets.length - 1]
  const representativeSource = sourceOverride ?? representative.source

  const updated = { ...entityMap }
  delete updated[entityId]
  updated[newEntityId] = {
    original: representative.original,
    placeholder: `[${newType} ${newNumber}]`,
    type: newType,
    source: representativeSource
  }

  return { entityMap: updated, entityId: newEntityId, rewrittenCount: targets.length }
}

export interface PropagationResult {
  /** Updated map with the new entityId added — orphans are NOT yet removed (caller does that). */
  entityMap: EntityMap
  /** The new entityId assigned to all propagated chips. */
  entityId: string
  /** Prior entityIds of chips that Pass B replaced (for orphan cleanup). */
  overwrittenEntityIds: Set<string>
  /** Total chips written in the transaction, INCLUDING the initial selection. */
  propagatedCount: number
}

/**
 * Manually anonymize the current selection AND auto-propagate the same flag to
 * every identical occurrence in the document (case-insensitive + Umlaut +
 * whole-word, multi-word as exact sequence). Existing chips of any type whose
 * `original` matches are overwritten with the new type/entityId.
 *
 * Returns null when:
 *  - the selection is empty
 *  - the extended selection is exactly one chip of the same type (silent no-op
 *    per AK 11)
 *  - the selection produces no extractable text
 */
export function anonymizeSelectionWithPropagation(
  editor: Editor,
  type: PlaceholderType,
  entityMap: EntityMap
): PropagationResult | null {
  const { state } = editor
  const { from, to, empty } = state.selection

  if (empty) return null

  const extended = extendSelectionAndExtractText(state, from, to)
  if (!extended.originalText.trim()) return null

  const { from: extFrom, to: extTo, originalText } = extended

  // AK 11 no-op detection: extended range is exactly one chip of the same type.
  const singleNode = state.doc.nodeAt(extFrom)
  if (
    singleNode?.type.name === 'placeholderChip' &&
    singleNode.attrs.type === type &&
    extTo - extFrom === singleNode.nodeSize
  ) {
    return null
  }

  const number = getNextNumber(entityMap, type)
  const entityId = generateEntityId(type, number)

  const hits = collectIdenticalOccurrences(state, originalText, {
    excludeRange: { from: extFrom, to: extTo },
    overwritesChips: true
  })

  const replacements: Array<{ from: number; to: number; original: string }> = [
    { from: extFrom, to: extTo, original: originalText },
    ...hits.map(({ from: f, to: t, original }) => ({ from: f, to: t, original }))
  ]

  replacements.sort((a, b) => b.from - a.from)

  const { tr } = state
  for (const rep of replacements) {
    const chipNode = state.schema.nodes.placeholderChip.create({
      entityId,
      type,
      number,
      source: 'manual',
      original: rep.original
    })
    tr.replaceWith(rep.from, rep.to, chipNode)
  }

  editor.view.dispatch(tr)

  const overwrittenEntityIds = new Set<string>()
  for (const hit of hits) {
    if (hit.overwrittenChip) overwrittenEntityIds.add(hit.overwrittenChip.entityId)
  }

  const updated = { ...entityMap }
  updated[entityId] = {
    original: originalText,
    placeholder: `[${type} ${number}]`,
    type,
    source: 'manual'
  }

  return {
    entityMap: updated,
    entityId,
    overwrittenEntityIds,
    propagatedCount: replacements.length
  }
}

/**
 * Walk `doc` once and reconcile `currentMap` against the chips actually
 * present in the document:
 *  - ADD entries for chips whose entityId is missing from the map
 *    (reconstruct from chip.attrs.{type, number, source, original})
 *  - REMOVE entries whose entityId has no chip in the document (orphans
 *    left behind by manual-flag overwrites that were later undone)
 *
 * Returns a new EntityMap when at least one add or remove happened; returns
 * null when no drift exists (churn guard — prevents redundant React renders
 * on Cmd+Z presses that didn't touch chips).
 *
 * Note on the async blocklist-redo race: when a blocklist redo restores
 * chips, the redo branch schedules `window.api.blocklist.add(...).then(cb)`
 * and the `.then(cb)` runs in a LATER microtask. By the time this reconciler
 * runs, the chip is in the doc but the entry may not yet be in `currentMap`.
 * The reconciler will reconstruct it from `chip.attrs.original`. When `cb`
 * later resolves, it overwrites with the canonical `stackEntry.term`. For
 * multi-variant blocklist chips ("Müller" + "mueller" sharing entityId),
 * the reconstructed `original` may differ from the canonical term for one
 * render frame. Auto-save fires AFTER `cb`, so persisted state is canonical.
 */
export function reconcileEntityMapWithDoc(doc: PMNode, currentMap: EntityMap): EntityMap | null {
  const present = new Set<string>()
  const result: EntityMap = { ...currentMap }
  let added = 0

  doc.descendants((node) => {
    if (node.type.name !== 'placeholderChip') return
    const entityId = node.attrs.entityId as string
    if (!entityId) return

    present.add(entityId)
    if (entityId in result) return

    const chipType = node.attrs.type as PlaceholderType
    const chipNumber = node.attrs.number as number
    const chipSource = node.attrs.source as EntityMap[string]['source']
    const chipOriginal = (node.attrs.original as string) ?? ''

    result[entityId] = {
      original: chipOriginal,
      placeholder: `[${chipType} ${chipNumber}]`,
      type: chipType,
      source: chipSource
    }
    added++
  })

  let removed = 0
  for (const key of Object.keys(result)) {
    if (!present.has(key)) {
      delete result[key]
      removed++
    }
  }

  return added > 0 || removed > 0 ? result : null
}
