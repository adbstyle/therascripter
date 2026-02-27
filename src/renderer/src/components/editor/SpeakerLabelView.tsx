import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'

export function SpeakerLabelView({ node }: NodeViewProps): React.JSX.Element {
  const { label } = node.attrs as { label: string }

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className="inline cursor-default text-sm font-semibold text-gray-700"
        contentEditable={false}
      >
        [{label}]:
      </span>
    </NodeViewWrapper>
  )
}
