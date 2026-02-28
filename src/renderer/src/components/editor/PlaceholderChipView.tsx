import { useState } from 'react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import type { PlaceholderType, EntitySource } from '../../../../shared/types'

const CHIP_STYLES: Record<PlaceholderType, string> = {
  PERSON: 'bg-chip-person-bg text-chip-person-text',
  ORT: 'bg-chip-ort-bg text-chip-ort-text',
  DATUM: 'bg-chip-datum-bg text-chip-datum-text',
  KONTAKT: 'bg-chip-kontakt-bg text-chip-kontakt-text',
  ORGANISATION: 'bg-chip-organisation-bg text-chip-organisation-text',
  MEDIZINISCH: 'bg-chip-medizinisch-bg text-chip-medizinisch-text',
  SONSTIGES: 'bg-chip-sonstiges-bg text-chip-sonstiges-text'
}

const SOURCE_LABELS: Record<EntitySource, { icon: string; label: string }> = {
  ner: { icon: '\uD83E\uDD16', label: 'Automatisch erkannt (NER)' },
  blocklist: { icon: '\uD83D\uDCD6', label: 'Sperrliste' },
  manual: { icon: '\u270F\uFE0F', label: 'Manuell markiert' }
}

export function PlaceholderChipView({ node, selected }: NodeViewProps): React.JSX.Element {
  const [showTooltip, setShowTooltip] = useState(false)
  const { type, number, source } = node.attrs as {
    type: PlaceholderType
    number: number
    source: EntitySource
    original: string
  }

  const chipStyle = CHIP_STYLES[type] || CHIP_STYLES.SONSTIGES
  const sourceInfo = SOURCE_LABELS[source] || SOURCE_LABELS.ner

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        className={`relative inline-flex cursor-default items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-medium leading-tight ${chipStyle} ${selected ? 'ring-2 ring-primary ring-offset-1' : ''}`}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        contentEditable={false}
      >
        <span>
          {type} {number}
        </span>
        <span className="text-[11px]" aria-hidden="true">
          {sourceInfo.icon}
        </span>

        {showTooltip && (
          <span
            className="absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-xs font-normal text-white shadow-lg dark:bg-gray-700"
            role="tooltip"
          >
            {type} &middot; {sourceInfo.label}
          </span>
        )}
      </span>
    </NodeViewWrapper>
  )
}
