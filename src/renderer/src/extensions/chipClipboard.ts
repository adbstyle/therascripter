import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { formatPlaceholderToken } from '../../../shared/utils/formatPlaceholderToken'
import type { TipTapPlaceholderChipAttrs } from '../../../shared/types/TipTapDocument'

const CHIP = 'placeholderChip'

/** Identity and `original` of each copied chip, in document order. */
type CopyRecord = Array<{ key: string; original: string }>

function chipKey(chip: PMNode): string {
  const { entityId, type, number, source } = chip.attrs as TipTapPlaceholderChipAttrs
  return `${entityId}\0${type}\0${number}\0${source}`
}

function chipsOf(fragment: Fragment): PMNode[] {
  const chips: PMNode[] = []
  fragment.descendants((node) => {
    if (node.type.name === CHIP) chips.push(node)
  })
  return chips
}

/** Rebuilds `fragment` with every chip replaced by `map(chip)`, in document order. */
function mapChips(fragment: Fragment, map: (chip: PMNode) => PMNode): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach((node) => {
    if (node.type.name === CHIP) nodes.push(map(node))
    else if (node.isLeaf) nodes.push(node)
    else nodes.push(node.copy(mapChips(node.content, map)))
  })
  return Fragment.fromArray(nodes)
}

/**
 * A chip's `original` (the clear name) is never rendered to HTML, so pasted
 * chips arrive without it. They get it back only when the paste provably
 * stems from the editor's last copy — same chips in the same order — and then
 * each chip its own variant ("Ruth Gerber" vs. "Frau Gerber" under one
 * entityId). Everything else (another session, where entityIds like
 * `person-1` denote a different person; HTML from an older app version or an
 * external app; a copy from before the editor was closed) becomes inert text
 * `[PERSON 1]`: a chip without `original` would break "Platzhalter entfernen"
 * and the EntityMap reconciliation.
 */
function restorePastedChips(slice: Slice, record: CopyRecord | null): Slice {
  const chips = chipsOf(slice.content)
  if (chips.length === 0) return slice

  const fromLastCopy =
    record !== null &&
    record.length === chips.length &&
    chips.every((chip, i) => chipKey(chip) === record[i].key)

  let index = 0
  const content = mapChips(slice.content, (chip) =>
    fromLastCopy
      ? chip.type.create({ ...chip.attrs, original: record[index++].original }, null, chip.marks)
      : chip.type.schema.text(
          formatPlaceholderToken(chip.attrs as TipTapPlaceholderChipAttrs),
          chip.marks
        )
  )
  return new Slice(content, slice.openStart, slice.openEnd)
}

/**
 * Remembers the chips of every Cmd+C / Cmd+X and restores them on paste. The
 * record belongs to this editor and dies with it — clear names live only as
 * long as the session is open, which also scopes restoration to that session.
 * Only real clipboard writes update it: a drag start must not replace the
 * record while the clipboard still holds the earlier copy.
 */
export function chipClipboardPlugin(): Plugin {
  let lastCopy: CopyRecord | null = null

  const remember = (view: EditorView): boolean => {
    const { selection } = view.state
    // ProseMirror writes nothing to the clipboard for an empty selection
    if (!selection.empty) {
      lastCopy = chipsOf(selection.content().content).map((chip) => ({
        key: chipKey(chip),
        original: (chip.attrs as TipTapPlaceholderChipAttrs).original
      }))
    }
    return false
  }

  return new Plugin({
    key: new PluginKey('chipClipboard'),
    props: {
      handleDOMEvents: { copy: remember, cut: remember },
      transformPasted(slice, view) {
        // Internal drag: ProseMirror drops the dragged slice itself, originals included
        if (view.dragging?.slice === slice) return slice
        return restorePastedChips(slice, lastCopy)
      }
    },
    // Also fires when a new state replaces the plugin array (ReviewEditor's
    // history reset at load, before any copy) — the record is dropped then too.
    view: () => ({
      destroy: () => {
        lastCopy = null
      }
    })
  })
}
