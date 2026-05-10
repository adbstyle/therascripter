import { useCallback, useMemo } from 'react'
import type { PlaceholderType, EntitySource } from '../../../../shared/types'
import {
  ANONYMIZE_TYPE_OPTIONS,
  BLOCKLIST_TYPE_OPTIONS
} from '../../constants/editorConstants'
import {
  ActionPopover,
  type ActionPopoverCloseReason,
  type ActionPopoverItem
} from './ActionPopover'

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
  onClose: (reason: ActionPopoverCloseReason) => void
  /**
   * When false, omit the "Pseudonym entfernen" item — used by the sidebar
   * IdentityRow which exposes revert as a direct button on the card so the
   * most common action is one click away. Defaults to true to preserve the
   * in-editor chip-menu behaviour, where revert lives in the popover.
   */
  showUndoItem?: boolean
}

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
  onClose,
  showUndoItem = true
}: ChipActionMenuProps): React.JSX.Element {
  const isBlocklisted = entitySource === 'blocklist'

  const items = useMemo<ActionPopoverItem[]>(() => {
    const list: ActionPopoverItem[] = []
    if (showUndoItem) {
      list.push({
        kind: 'action',
        key: 'undo',
        label: 'Pseudonym entfernen',
        supporting:
          occurrenceCount > 1 ? `»${original}« · ${occurrenceCount}×` : `»${original}«`
      })
    }
    list.push({
      kind: 'submenu',
      key: 'changeType',
      label: 'Typ ändern',
      // Current type is excluded — picking it would be a no-op, and would
      // expose a side-effect-before-validation path in the caller.
      options: ANONYMIZE_TYPE_OPTIONS.filter((opt) => opt.value !== entityType)
    })
    list.push({
      kind: 'submenu',
      key: 'blocklist',
      label: 'Zur Sperrliste hinzufügen',
      options: BLOCKLIST_TYPE_OPTIONS,
      disabled: isBlocklisted,
      disabledHint: 'Bereits in Sperrliste'
    })
    return list
  }, [original, occurrenceCount, entityType, isBlocklisted, showUndoItem])

  const handleSelect = useCallback(
    (itemKey: string, optionValue?: string) => {
      if (itemKey === 'undo') {
        onUndo(entityId)
        return
      }
      if (itemKey === 'changeType' && optionValue) {
        onChangeType(entityId, optionValue as PlaceholderType)
        return
      }
      if (itemKey === 'blocklist' && optionValue) {
        onAddToBlocklist(entityId, original, optionValue as PlaceholderType)
      }
    },
    [entityId, original, onUndo, onChangeType, onAddToBlocklist]
  )

  return (
    <ActionPopover
      anchorRect={anchorRect}
      ariaLabel={`Aktionen für ${entityType} ${entityNumber}`}
      submenuAriaLabels={{
        changeType: 'Typ ändern',
        blocklist: 'Zur Sperrliste hinzufügen'
      }}
      items={items}
      onSelect={handleSelect}
      onClose={onClose}
    />
  )
}
