import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import type { PlaceholderType, EntitySource } from '../../../../shared/types'
import { CHIP_STYLES, SOURCE_LABELS, formatPlaceholderLabel } from '../../constants/editorConstants'
import { ChipActionMenu } from './ChipActionMenu'
import { useChipActions } from '../../contexts/ChipActionsContext'

type TooltipPos = {
  x: number
  y: number
  placement: 'top' | 'bottom'
}

export function PlaceholderChipView({ node, selected }: NodeViewProps): React.JSX.Element {
  const chipRef = useRef<HTMLSpanElement>(null)
  const [tooltipPos, setTooltipPos] = useState<TooltipPos | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{
    rect: DOMRect
    occurrenceCount: number
  } | null>(null)
  const actions = useChipActions()

  const { entityId, type, number, source, original } = node.attrs as {
    entityId: string
    type: PlaceholderType
    number: number
    source: EntitySource
    original: string
  }

  const chipStyle = CHIP_STYLES[type] || CHIP_STYLES.SONSTIGES
  const sourceInfo = SOURCE_LABELS[source] || SOURCE_LABELS.ner
  const label = formatPlaceholderLabel(type, number)

  const showTooltipFromRect = useCallback((rect: DOMRect) => {
    const GAP = 6
    const TOOLTIP_HEIGHT_APPROX = 28
    const placement: 'top' | 'bottom' = rect.top > TOOLTIP_HEIGHT_APPROX + GAP ? 'top' : 'bottom'
    setTooltipPos({
      x: rect.left + rect.width / 2,
      y: placement === 'top' ? rect.top - GAP : rect.bottom + GAP,
      placement
    })
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (!chipRef.current) return
    showTooltipFromRect(chipRef.current.getBoundingClientRect())
  }, [showTooltipFromRect])

  const handleMouseLeave = useCallback(() => setTooltipPos(null), [])

  const handleFocus = useCallback(() => {
    if (!chipRef.current) return
    showTooltipFromRect(chipRef.current.getBoundingClientRect())
  }, [showTooltipFromRect])

  const handleBlur = useCallback(() => setTooltipPos(null), [])

  const openMenu = useCallback(() => {
    if (!chipRef.current || !actions) return
    setTooltipPos(null)
    setMenuAnchor({
      rect: chipRef.current.getBoundingClientRect(),
      occurrenceCount: actions.getOccurrenceCount(entityId)
    })
  }, [actions, entityId])

  const closeMenu = useCallback((reason: 'activated' | 'dismissed') => {
    setMenuAnchor(null)
    /*
     * On 'dismissed' (Escape, outside click, Tab) return focus to the chip so
     * keyboard navigation continues from where it started. On 'activated' the
     * action handler in ReviewEditor calls editor.commands.focus() — possibly
     * after an `await` — so we leave focus alone and let the editor own it.
     * Refocusing the chip here would race the async path (the chip may have
     * been removed before the IPC resolves) and would steal focus from the
     * editor in the sync path, breaking Cmd+Z.
     */
    if (reason === 'dismissed') chipRef.current?.focus()
  }, [])

  const handleClick = useCallback(() => {
    openMenu()
  }, [openMenu])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLSpanElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
    },
    [openMenu]
  )

  // Chips no longer expose a right-click menu — actions are exclusively
  // reachable via the trailing-chevron action menu. Right-click on a chip is
  // swallowed so the editor's text-selection context menu does not appear when
  // the chip itself is the click target.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // Callback ref: clamp tooltip horizontally within the viewport.
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

  // M3 state layers (8% hover / 10% focus + pressed / 12% selected) implemented
  // via a `before`-pseudo-element using `currentColor` so the tint is consistent
  // across all 7 type-colours in light + dark.
  const stateLayers =
    'relative isolate before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-current before:opacity-0 before:transition-opacity hover:before:opacity-[0.08] focus-visible:before:opacity-10 active:before:opacity-10 active:scale-[0.98]'

  const selectedClasses = selected ? 'before:opacity-[0.12] ring-2 ring-primary ring-offset-1' : ''

  const menuOpen = menuAnchor !== null

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        ref={chipRef}
        className={`inline-flex cursor-pointer items-center gap-1 rounded pl-1 pr-0.5 py-0.5 text-sm font-normal leading-tight outline-none focus-visible:outline-none ${chipStyle} ${stateLayers} ${selectedClasses}`}
        contentEditable={false}
        tabIndex={0}
        role="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`${label}, ${sourceInfo.label}. Aktionen verfügbar.`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <sourceInfo.icon className="relative h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="relative">{label}</span>
        <ChevronDown
          className="relative h-3.5 w-3.5 shrink-0 opacity-60"
          strokeWidth={1.75}
          aria-hidden
        />
      </span>

      {tooltipPos &&
        !menuOpen &&
        createPortal(
          <span
            ref={handleTooltipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              left: tooltipPos.x,
              top: tooltipPos.y,
              transform:
                tooltipPos.placement === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)',
              zIndex: 9999,
              pointerEvents: 'none'
            }}
            className="whitespace-nowrap rounded bg-tooltip-bg px-2 py-1 text-xs font-normal text-white shadow-lg"
          >
            {original}
          </span>,
          document.body
        )}

      {menuAnchor && actions && (
        <ChipActionMenu
          anchorRect={menuAnchor.rect}
          entityId={entityId}
          entityType={type}
          entityNumber={number}
          entitySource={source}
          original={original}
          occurrenceCount={menuAnchor.occurrenceCount}
          onUndo={actions.onUndo}
          onChangeType={actions.onChangeType}
          onAddToBlocklist={actions.onAddToBlocklist}
          onClose={closeMenu}
        />
      )}
    </NodeViewWrapper>
  )
}
