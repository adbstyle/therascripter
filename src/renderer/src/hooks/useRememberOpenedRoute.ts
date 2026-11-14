import { useEffect } from 'react'
import { useNavigation } from '../navigation/navigation'

/**
 * Merkt jedes geöffnete Patientendossier und jede geöffnete Sitzung in
 * «Zuletzt geöffnet» (#213). Läuft in der Shell, nicht in der Seitenleiste —
 * auch bei ausgeblendeter Seitenleiste wird gespeichert. Ein Sprung an eine
 * andere Stelle derselben Sitzung (`focus`) zählt nicht als neues Öffnen.
 */
export function useRememberOpenedRoute(): void {
  const { route } = useNavigation()
  const target =
    route.kind === 'dossier'
      ? { kind: 'dossier' as const, id: route.dossierId }
      : route.kind === 'session'
        ? { kind: 'session' as const, id: route.sessionId }
        : null
  const kind = target?.kind
  const id = target?.id

  useEffect(() => {
    if (!kind || !id) return
    window.api.recent.touch({ kind, id }).catch((error: unknown) => {
      // Nicht kritisch: der Eintrag fehlt dann nur in «Zuletzt geöffnet»
      console.error('[Zuletzt geöffnet] Speichern fehlgeschlagen:', error)
    })
  }, [kind, id])
}
