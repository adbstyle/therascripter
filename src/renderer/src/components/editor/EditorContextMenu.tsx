import { useEffect, useRef } from 'react'
import type { PlaceholderType } from '../../../../shared/types'

/** Types available for manual anonymization (Decision #151: 5 types) */
const ANONYMIZE_TYPES: Array<{ value: PlaceholderType; label: string }> = [
  { value: 'PERSON', label: 'Person' },
  { value: 'ORT', label: 'Ort' },
  { value: 'DATUM', label: 'Datum' },
  { value: 'KONTAKT', label: 'Kontakt' },
  { value: 'ORGANISATION', label: 'Organisation' }
]

/** Types available for blocklist quick-add (all 7 types including MEDIZINISCH/SONSTIGES) */
const BLOCKLIST_TYPES: Array<{ value: PlaceholderType; label: string }> = [
  { value: 'PERSON', label: 'Person' },
  { value: 'ORT', label: 'Ort' },
  { value: 'DATUM', label: 'Datum' },
  { value: 'KONTAKT', label: 'Kontakt' },
  { value: 'ORGANISATION', label: 'Organisation' },
  { value: 'MEDIZINISCH', label: 'Medizinisch' },
  { value: 'SONSTIGES', label: 'Sonstiges' }
]

export interface ContextMenuState {
  x: number
  y: number
  /** If set, the menu was opened on a chip — show "Rückgängig machen" */
  chip?: {
    entityId: string
    type: PlaceholderType
    number: number
    count: number
  }
  /** If true, text is selected — show "Anonymisieren als..." */
  hasSelection: boolean
}

interface EditorContextMenuProps {
  state: ContextMenuState
  onClose: () => void
  onBatchRemove: (entityId: string) => void
  onAnonymize: (type: PlaceholderType) => void
  onAddToBlocklist: (type: PlaceholderType) => void
}

export function EditorContextMenu({
  state,
  onClose,
  onBatchRemove,
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
      className="fixed z-50 min-w-[220px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
      style={style}
    >
      {/* Chip context: "Rückgängig machen" */}
      {state.chip && (
        <button
          className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-gray-50"
          onClick={() => {
            onBatchRemove(state.chip!.entityId)
            onClose()
          }}
        >
          <span className="font-medium text-gray-900">Rückgängig machen</span>
          <span className="text-xs text-gray-500">
            Macht alle [{state.chip.type} {state.chip.number}] im Text rückgängig
            {state.chip.count > 1 ? ` (${state.chip.count} Vorkommen)` : ''}
          </span>
        </button>
      )}

      {/* Separator when both chip and selection options present */}
      {state.chip && state.hasSelection && <div className="my-1 border-t border-gray-100" />}

      {/* Selection context: "Anonymisieren als..." */}
      {state.hasSelection && (
        <>
          <div className="px-3 py-1.5 text-xs font-medium text-gray-400">Anonymisieren als...</div>
          {ANONYMIZE_TYPES.map((type) => (
            <button
              key={`anon-${type.value}`}
              className="w-full px-3 py-1.5 text-left text-sm text-gray-900 hover:bg-gray-50"
              onClick={() => {
                onAnonymize(type.value)
                onClose()
              }}
            >
              {type.label}
            </button>
          ))}

          {/* Separator before blocklist section */}
          <div className="my-1 border-t border-gray-100" />

          {/* Blocklist quick-add: "Zur Sperrliste hinzufügen..." (US-6c) */}
          <div className="px-3 py-1.5 text-xs font-medium text-gray-400">
            Zur Sperrliste hinzufügen...
          </div>
          {BLOCKLIST_TYPES.map((type) => (
            <button
              key={`bl-${type.value}`}
              className="w-full px-3 py-1.5 text-left text-sm text-gray-900 hover:bg-gray-50"
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
    </div>
  )
}

/** Calculate menu position ensuring it stays within the viewport */
function getMenuPosition(x: number, y: number): React.CSSProperties {
  const menuWidth = 220
  const menuHeight = 500 // Increased to account for blocklist section
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
