import type { Node as PMNode, Slice } from '@tiptap/pm/model'
import {
  tiptapNodeToText,
  tiptapParagraphToText,
  type TipTapTextOptions
} from '../../../shared/utils/tiptapToText'

// Ohne sessionType-Weiche: PDF-Dokumente enthalten keine Speaker-/Timestamp-
// Nodes, und die editorProps-Closure sähe ohnehin nur den Initialwert.
const COPY_OPTIONS: TipTapTextOptions = {
  includeSpeakers: true,
  includeTimestamps: true,
  compact: false
}

/**
 * Plain-text flavor of a Cmd+C in the Review Editor (ProseMirror
 * `clipboardTextSerializer`). Node formats come from the shared walker; the
 * slice layout stays local on purpose: a selection is copied verbatim (no
 * trimming), one line per top-level paragraph. A NodeSelection slice holds a
 * bare chip (or speaker label/timestamp) and yields its token, like the HTML
 * flavor.
 */
export function serializeClipboardText(slice: Slice): string {
  let text = ''
  slice.content.forEach((node) => {
    if (node.type.name === 'paragraph') {
      if (text.length > 0) text += '\n'
      text += tiptapParagraphToText(node.toJSON(), COPY_OPTIONS)
    } else if (node.isInline) {
      text += clipboardNodeText(node)
    }
  })
  return text
}

/**
 * Visible text of an atom node (chip, speaker label, timestamp) in the HTML
 * flavor — the node's `renderHTML` content, identical to its text/plain token
 * (`[PERSON 1]`, `[Person A]:`, `[00:12:34]`). Without it the spans arrive
 * empty in mail/Word.
 */
export function clipboardNodeText(node: PMNode): string {
  return tiptapNodeToText(node.toJSON(), COPY_OPTIONS)
}
