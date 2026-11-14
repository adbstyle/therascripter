import { useSyncExternalStore } from 'react'
import { getViewModeStore } from './viewModeStore'
import type { ViewMode } from '../../../shared/types/ViewMode'

/** Current view (#203); re-renders the caller when it switches. */
export function useViewMode(): ViewMode {
  const store = getViewModeStore()
  return useSyncExternalStore(store.subscribe, store.get)
}

/** True in the Klartext view. */
export function useIsPlainView(): boolean {
  return useViewMode() === 'plain'
}
