import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { formatPlaceholderToken } from '../../../shared/utils/formatPlaceholderToken'
import type { TipTapPlaceholderChipAttrs } from '../../../shared/types/TipTapDocument'
import type { ViewMode } from '../../../shared/types/ViewMode'
import { getViewMode } from '../viewMode/viewModeStore'

const CHIP = 'placeholderChip'

/** Text a chip stands for in the Klartext view: its original, else its token (AK 6). */
export function plainChipText(chip: PMNode): string {
  const attrs = chip.attrs as TipTapPlaceholderChipAttrs
  return typeof attrs.original === 'string' && attrs.original.length > 0
    ? attrs.original
    : formatPlaceholderToken(attrs)
}

function plainFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach((node) => {
    if (node.type.name === CHIP) nodes.push(node.type.schema.text(plainChipText(node), node.marks))
    else if (node.isLeaf) nodes.push(node)
    else nodes.push(node.copy(plainFragment(node.content)))
  })
  // fromArray joins adjacent text nodes, so a chip becomes part of the sentence
  return Fragment.fromArray(nodes)
}

/**
 * The slice with every chip replaced by ordinary text — the Klartext form of
 * a copy. Both clipboard flavors are serialized from it, so the HTML carries
 * no chip markup that a later paste could turn back into chips (Out of
 * Scope 7): pasted Klartext is ordinary text.
 */
export function plainTextSlice(slice: Slice): Slice {
  return new Slice(plainFragment(slice.content), slice.openStart, slice.openEnd)
}

/**
 * Issue #203 — every way of copying out of the editor yields the chosen view
 * (AK 9). ProseMirror runs `transformCopied` for Cmd+C, Cmd+X and the start
 * of a drag, before it builds text/html and text/plain; in the pseudonymized
 * view the slice passes unchanged, so that path (and chipClipboard's
 * invariant that no original reaches the clipboard) stays exactly as before.
 *
 * In the Klartext view the editor is read-only and ProseMirror ignores Cmd+X
 * there; this plugin turns it into a copy without deleting anything (AK 8).
 */
export function viewModeClipboardPlugin(currentViewMode: () => ViewMode = getViewMode): Plugin {
  return new Plugin({
    key: new PluginKey('viewModeClipboard'),
    props: {
      transformCopied(slice) {
        return currentViewMode() === 'plain' ? plainTextSlice(slice) : slice
      },
      handleDOMEvents: {
        cut(view, event) {
          if (view.editable) return false
          const { selection } = view.state
          const data = event.clipboardData
          if (selection.empty || !data) return false
          const { dom, text } = view.serializeForClipboard(selection.content())
          event.preventDefault()
          data.clearData()
          data.setData('text/html', dom.innerHTML)
          data.setData('text/plain', text)
          return true
        }
      }
    }
  })
}
