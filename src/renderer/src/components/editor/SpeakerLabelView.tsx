import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'

export function SpeakerLabelView({ node }: NodeViewProps): React.JSX.Element {
  const { label } = node.attrs as { label: string }

  return (
    <NodeViewWrapper as="span" className="-ml-[0.27em] inline">
      <span className="inline cursor-default text-sm text-text-tertiary" contentEditable={false}>
        {label}
      </span>
    </NodeViewWrapper>
  )
}
