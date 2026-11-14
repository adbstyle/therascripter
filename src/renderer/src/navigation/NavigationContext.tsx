import { useCallback, useEffect, useMemo, useReducer } from 'react'
import type { ReactNode } from 'react'
import { initialNavState, navReducer, type NavigateOptions } from './navReducer'
import type { Route } from './routes'
import { NavigationContext, type BackOptions, type Navigation } from './navigation'

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

  const navigate = useCallback(
    (route: Route, options?: NavigateOptions) => dispatch({ type: 'navigate', route, options }),
    []
  )
  const back = useCallback(
    (options?: BackOptions) =>
      dispatch({ type: 'back', fromEntryId: options?.fromEntryId, fallback: options?.fallback }),
    []
  )
  const forward = useCallback(() => dispatch({ type: 'forward' }), [])

  useEffect(
    () =>
      window.api.nav.onCommand((command) => {
        if (command === 'back') dispatch({ type: 'back' })
        else if (command === 'forward') dispatch({ type: 'forward' })
      }),
    []
  )

  useEffect(
    () =>
      window.api.nav.onOpenSettings(() =>
        dispatch({ type: 'navigate', route: { kind: 'settings', subpage: null } })
      ),
    []
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
          predicate: (route) => route.kind === 'dossier' && deleted.has(route.dossierId)
        })
      }),
    []
  )

  const value = useMemo<Navigation>(
    () => ({
      route: state.current.route,
      entryId: state.current.id,
      anchorId: state.current.anchorId,
      canBack: state.back.length > 0,
      canForward: state.forward.length > 0,
      navigate,
      back,
      forward
    }),
    [state, navigate, back, forward]
  )

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
}
