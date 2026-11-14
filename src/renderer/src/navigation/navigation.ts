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
  canBack: boolean
  canForward: boolean
  navigate: (route: Route, options?: NavigateOptions) => void
  back: (options?: BackOptions) => void
  forward: () => void
}

export const NavigationContext = createContext<Navigation | null>(null)

export function useNavigation(): Navigation {
  const nav = useContext(NavigationContext)
  if (!nav) throw new Error('useNavigation braucht einen NavigationProvider')
  return nav
}
