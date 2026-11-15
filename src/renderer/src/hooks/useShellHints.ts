import { useAppUpdate } from './useAppUpdate'
import { useReconcileEvents } from './useReconcileEvents'

/** Text des Hinweispunkts nach einer automatischen Modell-Anpassung (#84). */
export const RECONCILE_HINT = 'Automatische Anpassung — Hinweis in Modelle'

export interface ShellHints {
  /** «Update bereit» / «Update verfügbar», wenn das Update die Nutzer:in braucht (#164, #167). */
  updateHint: string | null
  /** Automatische Modell-Anpassung noch nicht gesehen (#84); Einstellungen → Modelle räumt sie. */
  reconcilePending: boolean
}

/**
 * Hinweise der Shell an EINER Stelle: der Fuss der Seitenleiste zeigt sie,
 * bei eingeklappter Seitenleiste übernimmt die Titelleiste (Epic #192).
 */
export function useShellHints(): ShellHints {
  const { state, needsAttention } = useAppUpdate()
  const { pendingCount } = useReconcileEvents()
  const updateHint = !needsAttention
    ? null
    : state?.phase === 'ready'
      ? 'Update bereit'
      : 'Update verfügbar'
  return { updateHint, reconcilePending: pendingCount > 0 }
}
