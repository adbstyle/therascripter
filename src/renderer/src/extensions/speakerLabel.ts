import { ReactNodeViewRenderer } from '@tiptap/react'
import { SpeakerLabelView } from '../components/editor/SpeakerLabelView'
import { SpeakerLabelNode } from './transcriptNodes'

export const SpeakerLabel = SpeakerLabelNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SpeakerLabelView)
  }
})
