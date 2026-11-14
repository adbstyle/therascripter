/**
 * Issue #203 — global reading view of all sessions.
 *
 * `pseudonymized`: placeholders (`[PERSON 1]`) as chips, editable.
 * `plain`: every placeholder shows the original it replaces, read-only.
 */
export type ViewMode = 'pseudonymized' | 'plain'

/** Shown as long as no view was chosen or the chosen one is unknown (AK 11). */
export const DEFAULT_VIEW_MODE: ViewMode = 'pseudonymized'

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'pseudonymized' || value === 'plain'
}

/** Anything that is not a known view — missing, corrupt, unreadable — becomes the default. */
export function normalizeViewMode(value: unknown): ViewMode {
  return isViewMode(value) ? value : DEFAULT_VIEW_MODE
}
