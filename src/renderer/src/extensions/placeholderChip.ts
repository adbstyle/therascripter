import { ReactNodeViewRenderer } from '@tiptap/react'
import { PlaceholderChipView } from '../components/editor/PlaceholderChipView'
import { PlaceholderChipNode } from './transcriptNodes'

export const PlaceholderChip = PlaceholderChipNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PlaceholderChipView)
  }
})
