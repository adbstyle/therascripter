import { ReactNodeViewRenderer } from '@tiptap/react'
import { TimestampView } from '../components/editor/TimestampView'
import { TimestampNode } from './transcriptNodes'

export const Timestamp = TimestampNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TimestampView)
  }
})
