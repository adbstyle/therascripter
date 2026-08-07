import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'

const POPOVER_WIDTH = 240
const VIEWPORT_PADDING = 8
const ANCHOR_GAP = 4

export interface ActionPopoverActionItem {
  kind: 'action'
  key: string
  label: string
  supporting?: string
  disabled?: boolean
  disabledHint?: string
}

export interface ActionPopoverSubmenuItem {
  kind: 'submenu'
  key: string
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  disabled?: boolean
  disabledHint?: string
}

export type ActionPopoverItem = ActionPopoverActionItem | ActionPopoverSubmenuItem

/**
 * Why the popover is closing. Lets the host route focus correctly:
 *  - `'activated'` — an item was selected; the host's action handler owns
 *    where focus lands (typically the editor) and may run async.
 *  - `'dismissed'` — Escape, outside click, or Tab; the host should return
 *    focus to its trigger to keep keyboard navigation continuous.
 */
export type ActionPopoverCloseReason = 'activated' | 'dismissed'

export interface ActionPopoverProps {
  /** Anchor rect of the trigger in viewport coordinates. */
  anchorRect: DOMRect
  /** ARIA label for the main menu (e.g. "Aktionen für PERSON 1"). */
  ariaLabel: string
  /** Map from submenu key to its menu's ARIA label. */
  submenuAriaLabels: Record<string, string>
  items: ActionPopoverItem[]
  /** Single callback for item activation. For submenus, `optionValue` is set. */
  onSelect: (itemKey: string, optionValue?: string) => void
  onClose: (reason: ActionPopoverCloseReason) => void
}

/**
 * Generic floating popover with one optional supporting line per item and
 * fly-out submenus. Used by the chip action menu and the text-selection
 * toolbar — anywhere the editor needs a position-aware menu with submenus,
 * keyboard navigation, viewport clamping, and a fade-in.
 */
export function ActionPopover({
  anchorRect,
  ariaLabel,
  submenuAriaLabels,
  items,
  onSelect,
  onClose
}: ActionPopoverProps): React.JSX.Element {
  const mainRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [mainPos, setMainPos] = useState<{ left: number; top: number } | null>(null)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const [openSub, setOpenSub] = useState<string | null>(null)
  const [mainFocus, setMainFocus] = useState(0)
  const [subFocus, setSubFocus] = useState(0)
  const [visible, setVisible] = useState(false)

  const subItems = useMemo(() => {
    if (!openSub) return []
    const sub = items.find(
      (it): it is ActionPopoverSubmenuItem => it.kind === 'submenu' && it.key === openSub
    )
    return sub?.options ?? []
  }, [openSub, items])

  // Main menu positioning — open above the trigger if there's room, else below.
  useLayoutEffect(() => {
    if (!mainRef.current) return
    const rect = mainRef.current.getBoundingClientRect()
    const menuH = rect.height || 120
    const menuW = rect.width || POPOVER_WIDTH

    const spaceAbove = anchorRect.top - VIEWPORT_PADDING
    const spaceBelow = window.innerHeight - anchorRect.bottom - VIEWPORT_PADDING
    const placeAbove = spaceAbove >= menuH + ANCHOR_GAP || spaceAbove >= spaceBelow

    const top = placeAbove
      ? Math.max(VIEWPORT_PADDING, anchorRect.top - menuH - ANCHOR_GAP)
      : Math.min(window.innerHeight - menuH - VIEWPORT_PADDING, anchorRect.bottom + ANCHOR_GAP)

    const idealLeft = anchorRect.left + anchorRect.width / 2 - menuW / 2
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(window.innerWidth - menuW - VIEWPORT_PADDING, idealLeft)
    )

    setMainPos({ left, top })
    const rafId = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(rafId)
  }, [anchorRect])

  // Submenu positioning — to the right of main if room, else flip left.
  useLayoutEffect(() => {
    if (!openSub || !mainRef.current || !subRef.current || !mainPos) {
      setSubPos(null)
      return
    }
    const mainRect = mainRef.current.getBoundingClientRect()
    const subRect = subRef.current.getBoundingClientRect()
    const subW = subRect.width || POPOVER_WIDTH
    const subH = subRect.height || 200

    const triggerEl = mainRef.current.querySelector<HTMLElement>(`[data-menu-key="${openSub}"]`)
    const triggerRect = triggerEl?.getBoundingClientRect()
    const idealTop = triggerRect ? triggerRect.top : mainRect.top

    const spaceRight = window.innerWidth - mainRect.right - VIEWPORT_PADDING
    const flipLeft = spaceRight < subW + ANCHOR_GAP
    const left = flipLeft
      ? Math.max(VIEWPORT_PADDING, mainRect.left - subW - ANCHOR_GAP)
      : mainRect.right + ANCHOR_GAP

    const top = Math.max(
      VIEWPORT_PADDING,
      Math.min(window.innerHeight - subH - VIEWPORT_PADDING, idealTop)
    )

    setSubPos({ left, top })
  }, [openSub, mainPos])

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      const target = e.target as Node
      if (mainRef.current?.contains(target)) return
      if (subRef.current?.contains(target)) return
      onClose('dismissed')
    }
    const t = setTimeout(() => document.addEventListener('mousedown', handleClick), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  const activateMain = useCallback(
    (item: ActionPopoverItem | undefined) => {
      if (!item || item.disabled) return
      if (item.kind === 'action') {
        onSelect(item.key)
        onClose('activated')
        return
      }
      setOpenSub(item.key)
      setSubFocus(0)
    },
    [onSelect, onClose]
  )

  const activateSub = useCallback(
    (value: string | undefined) => {
      if (!value || !openSub) return
      onSelect(openSub, value)
      onClose('activated')
    },
    [openSub, onSelect, onClose]
  )

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        // The popover owns this Escape — prevent it from reaching window-level
        // listeners that would otherwise interpret it as a "close the editor"
        // gesture. Affects both the chip menu and the selection toolbar.
        e.stopPropagation()
        if (openSub) {
          setOpenSub(null)
          return
        }
        onClose('dismissed')
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (openSub) setSubFocus((i) => (i + 1) % subItems.length)
        else setMainFocus((i) => nextEnabled(items, i, +1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (openSub) setSubFocus((i) => (i - 1 + subItems.length) % subItems.length)
        else setMainFocus((i) => nextEnabled(items, i, -1))
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (!openSub) {
          const item = items[mainFocus]
          if (item?.kind === 'submenu' && !item.disabled) {
            setOpenSub(item.key)
            setSubFocus(0)
          }
        }
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (openSub) setOpenSub(null)
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (openSub) activateSub(subItems[subFocus]?.value)
        else activateMain(items[mainFocus])
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        onClose('dismissed')
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [openSub, mainFocus, subFocus, items, subItems, activateMain, activateSub, onClose])

  const handleHoverItem = useCallback(
    (idx: number) => {
      setMainFocus(idx)
      const item = items[idx]
      if (item?.kind === 'submenu' && !item.disabled) {
        setOpenSub(item.key)
        setSubFocus(0)
      } else {
        setOpenSub(null)
      }
    },
    [items]
  )

  const fade = visible ? 'opacity-100' : 'opacity-0'
  const submenuLabel = openSub ? submenuAriaLabels[openSub] || '' : ''

  return createPortal(
    <>
      <div
        ref={mainRef}
        role="menu"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        className={`fixed z-50 min-w-[240px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg transition-opacity duration-100 ${fade}`}
        style={mainPos ?? { left: -9999, top: -9999 }}
      >
        {items.map((item, idx) => {
          const focused = mainFocus === idx
          const baseClass =
            'flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm transition-colors'
          const stateClass = item.disabled
            ? 'cursor-not-allowed opacity-50'
            : focused
              ? 'bg-surface-2'
              : 'hover:bg-surface-2'
          return (
            <button
              key={item.key}
              data-menu-key={item.key}
              role="menuitem"
              aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={item.kind === 'submenu' ? openSub === item.key : undefined}
              aria-disabled={item.disabled || undefined}
              tabIndex={-1}
              disabled={item.disabled}
              className={`${baseClass} ${stateClass}`}
              onMouseEnter={() => handleHoverItem(idx)}
              onClick={() => activateMain(item)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-text-primary">{item.label}</span>
                {item.kind === 'action' && item.supporting && (
                  <span className="truncate text-xs text-text-tertiary">{item.supporting}</span>
                )}
                {item.disabled && item.disabledHint && (
                  <span className="text-xs text-text-tertiary">{item.disabledHint}</span>
                )}
              </span>
              {item.kind === 'submenu' && (
                <ChevronRight
                  className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary"
                  strokeWidth={1.75}
                  aria-hidden
                />
              )}
            </button>
          )
        })}
      </div>

      {openSub && subItems.length > 0 && (
        <div
          ref={subRef}
          role="menu"
          aria-label={submenuLabel}
          aria-orientation="vertical"
          className={`fixed z-50 min-w-[240px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg transition-opacity duration-100 ${fade}`}
          style={subPos ?? { left: -9999, top: -9999 }}
        >
          {subItems.map((opt, idx) => {
            const focused = subFocus === idx
            return (
              <button
                key={opt.value}
                role="menuitem"
                tabIndex={-1}
                className={`flex w-full items-center px-3 py-2 text-left text-sm text-text-primary transition-colors ${
                  focused ? 'bg-surface-2' : 'hover:bg-surface-2'
                }`}
                onMouseEnter={() => setSubFocus(idx)}
                onClick={() => activateSub(opt.value)}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </>,
    document.body
  )
}

function nextEnabled(items: ActionPopoverItem[], current: number, step: 1 | -1): number {
  const n = items.length
  for (let i = 1; i <= n; i++) {
    const idx = (current + step * i + n * n) % n
    if (!items[idx]?.disabled) return idx
  }
  return current
}
