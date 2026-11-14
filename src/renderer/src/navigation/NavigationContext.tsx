import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import { initialNavState, navReducer, type NavigateOptions } from './navReducer'
import type { Route } from './routes'
import {
  blurActiveElement,
  isModalDialogOpen,
  NavigationContext,
  type BackOptions,
  type Navigation
} from './navigation'

interface NavigationProviderProps {
  children: ReactNode
  initialRoute?: Route
}

/**
 * Verlauf der besuchten Seiten (Epic #192, #213 AK 5). Abonniert die
 * Menübefehle «Gehe zu» (`nav:command`), «Einstellungen…» aus App-Menü und
 * Tray (`nav:openSettings`) und entfernt gelöschte Sitzungen aus dem Verlauf
 * (`sessions:changed`, `dossiers:changed`, #213 PC 3).
 */
export function NavigationProvider({
  children,
  initialRoute
}: NavigationProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(navReducer, initialRoute, initialNavState)

  // Jeder Seitenwechsel löst zuerst den Fokus (Speichern beim Verlassen)
  const navigate = useCallback((route: Route, options?: NavigateOptions) => {
    blurActiveElement()
    dispatch({ type: 'navigate', route, options })
  }, [])
  const back = useCallback((options?: BackOptions) => {
    blurActiveElement()
    dispatch({ type: 'back', fromEntryId: options?.fromEntryId, fallback: options?.fallback })
  }, [])
  const forward = useCallback(() => {
    blurActiveElement()
    dispatch({ type: 'forward' })
  }, [])
  const consumeAnchor = useCallback(
    (entryId: number) => dispatch({ type: 'consumeAnchor', entryId }),
    []
  )
  const consumeOverlay = useCallback(
    (entryId: number) => dispatch({ type: 'consumeOverlay', entryId }),
    []
  )

  useEffect(
    () =>
      window.api.nav.onCommand((command) => {
        // ⌘[ / ⌘] wirken auch bei offenem Dialog (Menü-Kürzel) — dort nicht wechseln
        if (isModalDialogOpen()) return
        if (command === 'back') back()
        else if (command === 'forward') forward()
      }),
    [back, forward]
  )

  useEffect(
    () => window.api.nav.onOpenSettings(() => navigate({ kind: 'settings', subpage: null })),
    [navigate]
  )

  useEffect(
    () =>
      window.api.sessions.onChanged(({ deletedIds }) => {
        if (deletedIds.length === 0) return
        const deleted = new Set(deletedIds)
        dispatch({
          type: 'purge',
          predicate: (route) => route.kind === 'session' && deleted.has(route.sessionId)
        })
      }),
    []
  )

  // Gelöschte Patientendossiers verlassen den Verlauf; zeigt die aktuelle
  // Seite auf eines, ersetzt purge sie durch die Übersicht (#213 PC 3)
  useEffect(
    () =>
      window.api.dossiers.onChanged(({ deletedIds }) => {
        if (deletedIds.length === 0) return
        const deleted = new Set(deletedIds)
        dispatch({
          type: 'purge',
          predicate: (route) =>
            (route.kind === 'dossier' || route.kind === 'dossierSearch') &&
            deleted.has(route.dossierId)
        })
      }),
    []
  )

  const value = useMemo<Navigation>(
    () => ({
      route: state.current.route,
      entryId: state.current.id,
      anchorId: state.current.anchorId,
      reopenOverlay: state.current.reopenOverlay,
      canBack: state.back.length > 0,
      canForward: state.forward.length > 0,
      entryIds: [...state.back, state.current, ...state.forward].map((e) => e.id),
      navigate,
      back,
      forward,
      consumeAnchor,
      consumeOverlay
    }),
    [state, navigate, back, forward, consumeAnchor, consumeOverlay]
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}
