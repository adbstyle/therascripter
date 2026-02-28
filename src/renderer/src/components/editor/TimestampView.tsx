import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'

export function TimestampView({ node }: NodeViewProps): React.JSX.Element {
  const { formatted } = node.attrs as { formatted: string }

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className="inline cursor-default font-mono text-xs text-text-tertiary"
        contentEditable={false}
      >
        [{formatted}]
      </span>
    </NodeViewWrapper>
  )
}
