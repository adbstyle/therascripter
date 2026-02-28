import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
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

type TooltipPos = {
  x: number
  y: number
  placement: 'top' | 'bottom'
}

export function PlaceholderChipView({ node, selected }: NodeViewProps): React.JSX.Element {
  const [tooltipPos, setTooltipPos] = useState<TooltipPos | null>(null)
  const chipRef = useRef<HTMLSpanElement>(null)
  const { type, number, source, original } = node.attrs as {
    type: PlaceholderType
    number: number
    source: EntitySource
    original: string
  }

  const chipStyle = CHIP_STYLES[type] || CHIP_STYLES.SONSTIGES
  const sourceInfo = SOURCE_LABELS[source] || SOURCE_LABELS.ner

  const handleMouseEnter = useCallback(() => {
    if (!chipRef.current) return
    const rect = chipRef.current.getBoundingClientRect()
    const GAP = 6
    const TOOLTIP_HEIGHT_APPROX = 28
    const placement: 'top' | 'bottom' = rect.top > TOOLTIP_HEIGHT_APPROX + GAP ? 'top' : 'bottom'
    setTooltipPos({
      x: rect.left + rect.width / 2,
      y: placement === 'top' ? rect.top - GAP : rect.bottom + GAP,
      placement
    })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltipPos(null), [])

  // Callback ref: after tooltip is inserted into DOM, clamp it within the viewport horizontally
  const handleTooltipRef = useCallback(
    (el: HTMLSpanElement | null) => {
      if (!el || !tooltipPos) return
      const margin = 8
      const rect = el.getBoundingClientRect()
      if (rect.right > window.innerWidth - margin) {
        el.style.left = `${window.innerWidth - margin - rect.width}px`
        el.style.transform = tooltipPos.placement === 'top' ? 'translateY(-100%)' : 'none'
      } else if (rect.left < margin) {
        el.style.left = `${margin}px`
        el.style.transform = tooltipPos.placement === 'top' ? 'translateY(-100%)' : 'none'
      }
    },
    [tooltipPos]
  )

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        ref={chipRef}
        className={`inline-flex cursor-default items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-medium leading-tight ${chipStyle} ${selected ? 'ring-2 ring-primary ring-offset-1' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        contentEditable={false}
      >
        <span>
          {type} {number}
        </span>
        <span className="text-[11px]" aria-hidden="true">
          {sourceInfo.icon}
        </span>
      </span>

      {tooltipPos &&
        createPortal(
          <span
            ref={handleTooltipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              left: tooltipPos.x,
              top: tooltipPos.y,
              transform: tooltipPos.placement === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
              zIndex: 9999,
              pointerEvents: 'none'
            }}
            className="whitespace-nowrap rounded bg-tooltip-bg px-2 py-1 text-xs font-normal text-white shadow-lg"
          >
            {original}
          </span>,
          document.body
        )}
    </NodeViewWrapper>
  )
}
