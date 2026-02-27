import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { PlaceholderChipView } from '../components/editor/PlaceholderChipView'

export const PlaceholderChip = Node.create({
  name: 'placeholderChip',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      entityId: { default: '' },
      type: { default: 'PERSON' },
      number: { default: 1 },
      source: { default: 'ner' },
      original: { default: '' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="placeholderChip"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'placeholderChip' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(PlaceholderChipView)
  }
})
