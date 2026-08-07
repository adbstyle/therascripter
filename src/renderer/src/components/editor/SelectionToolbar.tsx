import { useCallback, useMemo } from 'react'
import type { PlaceholderType } from '../../../../shared/types'
import { ANONYMIZE_TYPE_OPTIONS, BLOCKLIST_TYPE_OPTIONS } from '../../constants/editorConstants'
import {
  ActionPopover,
  type ActionPopoverCloseReason,
  type ActionPopoverItem
} from './ActionPopover'

interface SelectionToolbarProps {
  /** Bounding rect of the user's text selection in viewport coordinates. */
  anchorRect: DOMRect
  /**
   * True when the selection consists exclusively of two or more chips with no
   * neutral text — re-pseudonymizing such a range is ambiguous, so both
   * actions render disabled with a hint.
   */
  multiChipSelectionOnly: boolean
  onAnonymize: (type: PlaceholderType) => void
  onAddToBlocklist: (type: PlaceholderType) => void
  onClose: (reason: ActionPopoverCloseReason) => void
}

/**
 * Floating toolbar that appears above (or below, on viewport collision) a
 * non-empty text selection in the Review Editor. Replaces the previous
 * right-click context menu, surfacing the two pseudonymization actions
 * directly when a user finishes selecting text.
 */
export function SelectionToolbar({
  anchorRect,
  multiChipSelectionOnly,
  onAnonymize,
  onAddToBlocklist,
  onClose
}: SelectionToolbarProps): React.JSX.Element {
  const items = useMemo<ActionPopoverItem[]>(
    () => [
      {
        kind: 'submenu',
        key: 'anonymize',
        label: 'Pseudonymisieren',
        options: ANONYMIZE_TYPE_OPTIONS,
        disabled: multiChipSelectionOnly,
        disabledHint: multiChipSelectionOnly
          ? 'Mehrere Chips können nicht zusammen pseudonymisiert werden'
          : undefined
      },
      {
        kind: 'submenu',
        key: 'blocklist',
        label: 'Auf Sperrliste setzen',
        options: BLOCKLIST_TYPE_OPTIONS,
        disabled: multiChipSelectionOnly,
        disabledHint: multiChipSelectionOnly
          ? 'Mehrere Chips können nicht auf die Sperrliste gesetzt werden'
          : undefined
      }
    ],
    [multiChipSelectionOnly]
  )

  const handleSelect = useCallback(
    (itemKey: string, optionValue?: string) => {
      if (!optionValue) return
      if (itemKey === 'anonymize') onAnonymize(optionValue as PlaceholderType)
      else if (itemKey === 'blocklist') onAddToBlocklist(optionValue as PlaceholderType)
    },
    [onAnonymize, onAddToBlocklist]
  )

  return (
    <ActionPopover
      anchorRect={anchorRect}
      ariaLabel="Aktionen für die aktuelle Auswahl"
      submenuAriaLabels={{
        anonymize: 'Pseudonymisieren',
        blocklist: 'Auf Sperrliste setzen'
      }}
      items={items}
      onSelect={handleSelect}
      onClose={onClose}
    />
  )
}
