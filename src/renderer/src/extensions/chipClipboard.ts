import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { formatPlaceholderToken } from '../../../shared/utils/formatPlaceholderToken'
import type { TipTapPlaceholderChipAttrs } from '../../../shared/types/TipTapDocument'

const CHIP = 'placeholderChip'

/**
 * Chips of the last copy (Cmd+C, Cmd+X, drag start) out of a Review Editor:
 * identity in document order plus each chip's `original`. Module scope on
 * purpose — a paste after leaving and reopening the same session still finds
 * it. Lives only in renderer memory, never in the clipboard.
 */
interface CopyRecord {
  sessionId: string
  chips: Array<{ key: string; original: string }>
}

let lastCopy: CopyRecord | null = null

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
 * stems from the last copy in the same session — same chips in the same
 * order — and then each chip its own variant ("Ruth Gerber" vs.
 * "Frau Gerber" under one entityId). Everything else (another session, where
 * entityIds like `person-1` denote a different person; HTML from an older
 * app version or an external app) becomes inert text `[PERSON 1]`: a chip
 * without `original` would break "Platzhalter entfernen" and the
 * EntityMap reconciliation.
 */
function restorePastedChips(slice: Slice, sessionId: string | null): Slice {
  const chips = chipsOf(slice.content)
  if (chips.length === 0) return slice

  const record = lastCopy
  const fromThisSession =
    record !== null &&
    sessionId !== null &&
    record.sessionId === sessionId &&
    record.chips.length === chips.length &&
    chips.every((chip, i) => chipKey(chip) === record.chips[i].key)

  let index = 0
  const content = mapChips(slice.content, (chip) =>
    fromThisSession
      ? chip.type.create(
          { ...chip.attrs, original: record.chips[index++].original },
          null,
          chip.marks
        )
      : chip.type.schema.text(
          formatPlaceholderToken(chip.attrs as TipTapPlaceholderChipAttrs),
          chip.marks
        )
  )
  return new Slice(content, slice.openStart, slice.openEnd)
}

/** `getSessionId() === null` (not configured) never restores chips on paste. */
export function chipClipboardPlugin(getSessionId: () => string | null): Plugin {
  return new Plugin({
    key: new PluginKey('chipClipboard'),
    props: {
      transformCopied(slice) {
        const sessionId = getSessionId()
        lastCopy =
          sessionId === null
            ? null
            : {
                sessionId,
                chips: chipsOf(slice.content).map((chip) => ({
                  key: chipKey(chip),
                  original: (chip.attrs as TipTapPlaceholderChipAttrs).original
                }))
              }
        return slice
      },
      transformPasted(slice) {
        return restorePastedChips(slice, getSessionId())
      }
    }
  })
}
