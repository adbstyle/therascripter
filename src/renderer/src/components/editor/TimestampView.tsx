import { NodeViewWrapper } from '@tiptap/react'

export function TimestampView(): React.JSX.Element {
  return <NodeViewWrapper as="span" className="hidden" contentEditable={false} />
}
