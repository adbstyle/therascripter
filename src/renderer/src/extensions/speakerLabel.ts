import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { SpeakerLabelView } from '../components/editor/SpeakerLabelView'

export const SpeakerLabel = Node.create({
  name: 'speakerLabel',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      speaker: { default: 'A' },
      label: { default: 'Person A' }
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="speakerLabel"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'speakerLabel' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(SpeakerLabelView)
  }
})
