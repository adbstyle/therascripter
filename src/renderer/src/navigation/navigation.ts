import { createContext, useContext } from 'react'
import type { NavigateOptions } from './navReducer'
import type { Route } from './routes'

export interface BackOptions {
  /** Nur zurück, wenn dieser Eintrag noch der aktuelle ist (Schutz vor Doppelschritt). */
  fromEntryId?: number
  /** Ziel, wenn der Verlauf zurück nichts mehr hergibt. */
  fallback?: Route
}

export interface Navigation {
  route: Route
  /** Eindeutig pro Besuch — Schlüssel für Scroll-Position und Seiten-Remount. */
  entryId: number
  /** Karte, die auf dieser Seite beim Zurückkehren hervorgehoben wird. */
  anchorId: string | undefined
  /** Overlay, das beim Zurückkehren auf diese Seite wieder aufgeht (#209 AK 12). */
  reopenOverlay: 'search' | undefined
  canBack: boolean
  canForward: boolean
  /** IDs aller Einträge im Verlauf — wer Daten pro Eintrag hält, räumt damit auf. */
  entryIds: number[]
  navigate: (route: Route, options?: NavigateOptions) => void
  back: (options?: BackOptions) => void
  forward: () => void
  /** Anker eines Eintrags verwerfen, nachdem er eingelöst wurde. */
  consumeAnchor: (entryId: number) => void
  /** Wieder zu öffnendes Overlay verwerfen, nachdem es geöffnet wurde. */
  consumeOverlay: (entryId: number) => void
}

/** Ein modaler Dialog ist offen — Menübefehle wechseln dann nicht die Seite. */
export function isModalDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

/**
 * Vor jedem Seitenwechsel den Fokus lösen: Eingaben, die beim Verlassen
 * speichern (z. B. der Titel im Editor), speichern so noch, bevor die Seite
 * verschwindet.
 */
export function blurActiveElement(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

export const NavigationContext = createContext<Navigation | null>(null)

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext)
  if (!nav) throw new Error('useNavigation braucht einen NavigationProvider')
  return nav
}
