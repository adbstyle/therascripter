import { createContext, useContext } from 'react'
import type { PlaceholderType } from '../../../shared/types'

/**
 * Bridge between PlaceholderChipView (rendered inside Tiptap) and ReviewEditor's
 * action handlers. The chip view consumes this context to invoke menu actions
 * without holding direct references to the editor or React state in
 * ReviewEditor.tsx.
 *
 * `getOccurrenceCount` is invoked only when the chip's action menu opens (not
 * on every chip render) so a doc-wide walk does not happen for every paint.
 */
export interface ChipActions {
  onUndo: (entityId: string) => void
  onChangeType: (entityId: string, newType: PlaceholderType) => void
  onAddToBlocklist: (entityId: string, original: string, type: PlaceholderType) => void
  getOccurrenceCount: (entityId: string) => number
}

export const ChipActionsContext = createContext<ChipActions | null>(null)

export function useChipActions(): ChipActions | null {
  return useContext(ChipActionsContext)
}
