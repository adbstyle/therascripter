import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { PlaceholderType, EntitySource } from '../../../../shared/types'
import {
  ANONYMIZE_TYPE_OPTIONS,
  BLOCKLIST_TYPE_OPTIONS
} from '../../constants/editorConstants'

const MAIN_MENU_WIDTH = 240
const SUBMENU_WIDTH = 200
const VIEWPORT_PADDING = 8
const ANCHOR_GAP = 4

interface ChipActionMenuProps {
  /** Anchor rect of the chip in viewport coordinates. */
  anchorRect: DOMRect
  entityId: string
  entityType: PlaceholderType
  entityNumber: number
  entitySource: EntitySource
  original: string
  occurrenceCount: number
  onUndo: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
  onClose: () => void
}

type SubmenuKey = 'changeType' | 'blocklist'
type MainItemKey = 'undo' | SubmenuKey

interface ActionItem {
  kind: 'action'
  key: 'undo'
  label: string
  supporting: string
}

interface SubmenuItem {
  kind: 'submenu'
  key: SubmenuKey
  label: string
  disabled?: boolean
  disabledHint?: string
}

type MainItem = ActionItem | SubmenuItem

export function ChipActionMenu({
  anchorRect,
  entityId,
  entityType,
  entityNumber,
  entitySource,
  original,
  occurrenceCount,
  onUndo,
  onChangeType,
  onAddToBlocklist,
  onClose
}: ChipActionMenuProps): React.JSX.Element {
  const mainRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [mainPos, setMainPos] = useState<{ left: number; top: number } | null>(null)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const [openSub, setOpenSub] = useState<SubmenuKey | null>(null)
  const [mainFocus, setMainFocus] = useState(0)
  const [subFocus, setSubFocus] = useState(0)
  const [visible, setVisible] = useState(false)

  const isBlocklisted = entitySource === 'blocklist'

  const mainItems = useMemo<MainItem[]>(
    () => [
      {
        kind: 'action',
        key: 'undo',
        label: 'Rückgängig machen',
        supporting:
          occurrenceCount > 1
            ? `Hebt ${occurrenceCount} Vorkommen ${entityType} ${entityNumber} auf`
            : `Hebt ${entityType} ${entityNumber} auf`
      },
      { kind: 'submenu', key: 'changeType', label: 'Typ ändern' },
      {
        kind: 'submenu',
        key: 'blocklist',
        label: 'Zur Sperrliste hinzufügen',
        disabled: isBlocklisted,
        disabledHint: 'Bereits in Sperrliste'
      }
    ],
    [entityType, entityNumber, occurrenceCount, isBlocklisted]
  )

  const subItems = useMemo(() => {
    if (openSub === 'changeType') return ANONYMIZE_TYPE_OPTIONS
    if (openSub === 'blocklist') return BLOCKLIST_TYPE_OPTIONS
    return []
  }, [openSub])

  // Main menu positioning — open above the chip if there's room, else below.
  useLayoutEffect(() => {
    if (!mainRef.current) return
    const rect = mainRef.current.getBoundingClientRect()
    const menuH = rect.height || 120
    const menuW = rect.width || MAIN_MENU_WIDTH

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
    // Mount transparent, flip to visible on the next frame so the 100 ms fade-in
    // has somewhere to start (per Issue #88 NFR-3 / design decision).
    requestAnimationFrame(() => setVisible(true))
  }, [anchorRect])

  // Submenu positioning — to the right of main if room, else flip left.
  useLayoutEffect(() => {
    if (!openSub || !mainRef.current || !subRef.current || !mainPos) {
      setSubPos(null)
      return
    }
    const mainRect = mainRef.current.getBoundingClientRect()
    const subRect = subRef.current.getBoundingClientRect()
    const subW = subRect.width || SUBMENU_WIDTH
    const subH = subRect.height || 200

    // Locate the trigger element via its data-menu-key — robust against future
    // reordering or insertion of new main items.
    const triggerEl = mainRef.current.querySelector<HTMLElement>(
      `[data-menu-key="${openSub}"]`
    )
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
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', handleClick), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  const activateMain = useCallback(
    (item: MainItem | undefined) => {
      if (!item) return
      if (item.kind === 'submenu' && item.disabled) return
      if (item.kind === 'action' && item.key === 'undo') {
        onUndo(entityId)
        onClose()
        return
      }
      if (item.kind === 'submenu') {
        setOpenSub(item.key)
        setSubFocus(0)
      }
    },
    [entityId, onUndo, onClose]
  )

  const activateSub = useCallback(
    (value: PlaceholderType | undefined) => {
      if (!value) return
      if (openSub === 'changeType') {
        onChangeType(entityId, value)
      } else if (openSub === 'blocklist') {
        onAddToBlocklist(entityId, original, value)
      }
      onClose()
    },
    [openSub, entityId, original, onChangeType, onAddToBlocklist, onClose]
  )

  // Keyboard navigation (single global listener — menu owns focus while open).
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (openSub) {
          setOpenSub(null)
          return
        }
        onClose()
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (openSub) {
          setSubFocus((i) => (i + 1) % subItems.length)
        } else {
          setMainFocus((i) => nextEnabled(mainItems, i, +1))
        }
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (openSub) {
          setSubFocus((i) => (i - 1 + subItems.length) % subItems.length)
        } else {
          setMainFocus((i) => nextEnabled(mainItems, i, -1))
        }
        return
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        if (!openSub) {
          const item = mainItems[mainFocus]
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
        if (openSub) {
          activateSub(subItems[subFocus]?.value)
        } else {
          activateMain(mainItems[mainFocus])
        }
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        onClose()
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [openSub, mainFocus, subFocus, mainItems, subItems, activateMain, activateSub, onClose])

  const handleHoverItem = useCallback(
    (idx: number) => {
      setMainFocus(idx)
      const item = mainItems[idx]
      if (item?.kind === 'submenu' && !item.disabled) {
        setOpenSub(item.key)
        setSubFocus(0)
      } else {
        setOpenSub(null)
      }
    },
    [mainItems]
  )

  const fade = visible ? 'opacity-100' : 'opacity-0'

  return createPortal(
    <>
      <div
        ref={mainRef}
        role="menu"
        aria-label={`Aktionen für ${entityType} ${entityNumber}`}
        aria-orientation="vertical"
        className={`fixed z-50 min-w-[240px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg transition-opacity duration-100 ${fade}`}
        style={mainPos ?? { left: -9999, top: -9999 }}
      >
        {mainItems.map((item, idx) => {
          const focused = mainFocus === idx
          const disabled = item.kind === 'submenu' && item.disabled
          const baseClass =
            'flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm transition-colors'
          const stateClass = disabled
            ? 'cursor-not-allowed opacity-50'
            : focused
              ? 'bg-surface-2'
              : 'hover:bg-surface-2'
          return (
            <button
              key={item.key}
              data-menu-key={item.key satisfies MainItemKey}
              role="menuitem"
              aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={item.kind === 'submenu' ? openSub === item.key : undefined}
              aria-disabled={disabled || undefined}
              tabIndex={-1}
              disabled={disabled}
              className={`${baseClass} ${stateClass}`}
              onMouseEnter={() => handleHoverItem(idx)}
              onClick={() => activateMain(item)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-text-primary">{item.label}</span>
                {item.kind === 'action' && (
                  <span className="text-xs text-text-tertiary">{item.supporting}</span>
                )}
                {item.kind === 'submenu' && item.disabled && item.disabledHint && (
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
          aria-label={openSub === 'changeType' ? 'Typ ändern' : 'Zur Sperrliste hinzufügen'}
          aria-orientation="vertical"
          className={`fixed z-50 min-w-[200px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg transition-opacity duration-100 ${fade}`}
          style={subPos ?? { left: -9999, top: -9999 }}
        >
          {subItems.map((opt, idx) => {
            const focused = subFocus === idx
            return (
              <button
                key={opt.value}
                role="menuitem"
                tabIndex={-1}
                className={`w-full px-3 py-1.5 text-left text-sm text-text-primary transition-colors ${
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

function nextEnabled(items: MainItem[], current: number, step: 1 | -1): number {
  const n = items.length
  for (let i = 1; i <= n; i++) {
    const idx = (current + step * i + n * n) % n
    const item = items[idx]
    const disabled = item?.kind === 'submenu' && item.disabled
    if (!disabled) return idx
  }
  return current
}
