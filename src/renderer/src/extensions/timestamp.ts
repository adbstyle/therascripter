import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { TimestampView } from '../components/editor/TimestampView'

export const Timestamp = Node.create({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      seconds: { default: 0 },
      formatted: { default: '00:00:00' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="timestamp"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'timestamp' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TimestampView)
  }
})
