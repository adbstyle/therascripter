import { createValueStore, type WritableValueStore } from '../utils/valueStore'
import { normalizeViewMode, type ViewMode } from '../../../shared/types/ViewMode'

/**
 * Issue #203 — the one source of the current view in the renderer. React
 * reads it through `useViewMode`, the editor's clipboard plugin directly
 * (`getViewMode`) — a ProseMirror plugin lives outside the React tree.
 *
 * Created on first access from `window.api.viewMode.initial`, which the
 * preload read synchronously from the saved settings: the very first render
 * shows the chosen view (AK 12). No or an unknown value → pseudonymized (AK 11).
 */
let store: WritableValueStore<ViewMode> | null = null

function initialViewMode(): ViewMode {
  try {
    return normalizeViewMode(window.api?.viewMode?.initial)
  } catch {
    return normalizeViewMode(undefined)
  }
}

export function getViewModeStore(): WritableValueStore<ViewMode> {
  store ??= createValueStore<ViewMode>(initialViewMode())
  return store
}

export function getViewMode(): ViewMode {
  return getViewModeStore().get()
}

/**
 * Switches the view everywhere at once — synchronously, so every visible
 * text changes in the same frame (AK 13) — and saves it for all sessions and
 * the next start (AK 10). A failed save keeps the switch for this run.
 */
export function setViewMode(mode: ViewMode): void {
  getViewModeStore().set(mode)
  try {
    window.api?.viewMode?.set(mode)?.catch((err: unknown) => {
      console.error('Ansicht konnte nicht gespeichert werden:', err)
    })
  } catch (err) {
    console.error('Ansicht konnte nicht gespeichert werden:', err)
  }
}

/** Test-only — next access re-reads `window.api.viewMode.initial`. */
export function _resetViewModeStoreForTests(): void {
  store = null
}
