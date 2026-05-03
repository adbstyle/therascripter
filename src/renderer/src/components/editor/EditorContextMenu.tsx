import { useEffect, useRef } from 'react'
import type { PlaceholderType } from '../../../../shared/types'
import { ANONYMIZE_TYPE_OPTIONS, BLOCKLIST_TYPE_OPTIONS } from '../../constants/editorConstants'

export interface ContextMenuState {
  x: number
  y: number
  /**
   * Always true — the menu is only opened on a non-empty text selection.
   * Chip-target right-clicks are swallowed by PlaceholderChipView; chip
   * actions live in the inline trailing-chevron menu.
   */
  hasSelection: boolean
  /**
   * If true, the selection consists exclusively of two or more chips with no
   * neutral text outside them — re-flagging would be ambiguous, so the
   * "Pseudonymisieren als..." block is hidden.
   */
  selectionSpansMultipleChipsOnly: boolean
}

interface EditorContextMenuProps {
  state: ContextMenuState
  onClose: () => void
  onAnonymize: (type: PlaceholderType) => void
  onAddToBlocklist: (type: PlaceholderType) => void
}

export function EditorContextMenu({
  state,
  onClose,
  onAnonymize,
  onAddToBlocklist
}: EditorContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Use setTimeout to avoid closing immediately from the contextmenu event
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  // Adjust position to keep menu within viewport
  const style = getMenuPosition(state.x, state.y)

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[220px] rounded-lg border border-border bg-surface-1 py-1 shadow-lg"
      style={style}
    >
      {!state.selectionSpansMultipleChipsOnly && (
        <>
          <div className="px-3 py-1.5 text-xs font-medium text-text-tertiary">
            Pseudonymisieren als...
          </div>
          {ANONYMIZE_TYPE_OPTIONS.map((type) => (
            <button
              key={`anon-${type.value}`}
              className="w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-surface-2"
              onClick={() => {
                onAnonymize(type.value)
                onClose()
              }}
            >
              {type.label}
            </button>
          ))}

          <div className="my-1 border-t border-border" />

          <div className="px-3 py-1.5 text-xs font-medium text-text-tertiary">
            Zur Sperrliste hinzufügen...
          </div>
          {BLOCKLIST_TYPE_OPTIONS.map((type) => (
            <button
              key={`bl-${type.value}`}
              className="w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-surface-2"
              onClick={() => {
                onAddToBlocklist(type.value)
                onClose()
              }}
            >
              {type.label}
            </button>
          ))}
        </>
      )}

      {state.selectionSpansMultipleChipsOnly && (
        <div className="px-3 py-2 text-xs text-text-tertiary">
          Bitte nur einen Chip auswählen, um neu zu kategorisieren.
        </div>
      )}
    </div>
  )
}

/** Calculate menu position ensuring it stays within the viewport */
function getMenuPosition(x: number, y: number): React.CSSProperties {
  const menuWidth = 220
  const menuHeight = 500
  const padding = 8

  const adjustedX =
    x + menuWidth > window.innerWidth - padding ? window.innerWidth - menuWidth - padding : x
  const adjustedY =
    y + menuHeight > window.innerHeight - padding ? window.innerHeight - menuHeight - padding : y

  return {
    left: Math.max(padding, adjustedX),
    top: Math.max(padding, adjustedY)
  }
}
