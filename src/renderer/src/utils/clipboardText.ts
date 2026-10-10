import type { Slice } from '@tiptap/pm/model'

/**
 * Plain-text flavor of a Cmd+C in the Review Editor (ProseMirror
 * `clipboardTextSerializer`).
 */
export function serializeClipboardText(slice: Slice): string {
  let text = ''
  slice.content.forEach((node) => {
    if (node.type.name === 'paragraph') {
      if (text.length > 0) text += '\n'
      node.content.forEach((child) => {
        if (child.type.name === 'text') {
          text += child.text ?? ''
        } else if (child.type.name === 'placeholderChip') {
          text += `[${child.attrs.type} ${child.attrs.number}]`
        } else if (child.type.name === 'speakerLabel') {
          text += `[${child.attrs.label}]:`
        } else if (child.type.name === 'timestamp') {
          text += `[${child.attrs.formatted}]`
        }
      })
    }
  })
  return text
}
