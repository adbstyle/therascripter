import type { Slice } from '@tiptap/pm/model'
import { tiptapParagraphToText, type TipTapTextOptions } from '../../../shared/utils/tiptapToText'

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
 * trimming), and only top-level paragraphs count — a NodeSelection slice
 * holds a bare chip and falls through to ProseMirror's default.
 */
export function serializeClipboardText(slice: Slice): string {
  let text = ''
  slice.content.forEach((node) => {
    if (node.type.name !== 'paragraph') return
    if (text.length > 0) text += '\n'
    text += tiptapParagraphToText(node.toJSON(), COPY_OPTIONS)
  })
  return text
}
