import { useCallback } from 'react'
import { useNavigation } from '../../navigation/navigation'
import { HOME_ROUTE, type SubPage } from '../../navigation/routes'
import SessionsPage from '../../views/SessionsPage'
import ReviewEditor from '../../views/ReviewEditor'
import Settings from '../../views/Settings'
import { PageContainer, PageHeader } from './PageHeader'

/** Rendert die Seite der aktuellen Route (Epic #192). */
export default function RouteView(): React.JSX.Element {
  const { route, entryId, navigate, back } = useNavigation()

  // Esc und «Zurück» im Editor: nur wenn der Editor noch die aktuelle Seite
  // ist (das Löschen kann den Eintrag schon entfernt haben), sonst
  // Sitzungsliste, falls der Verlauf zurück nichts hergibt.
  const closeSession = useCallback(
    () => back({ fromEntryId: entryId, fallback: HOME_ROUTE }),
    [back, entryId]
  )
  const openSubpage = useCallback(
    (subpage: SubPage | null) => navigate({ kind: 'settings', subpage }),
    [navigate]
  )

  switch (route.kind) {
    case 'sessions':
      return <SessionsPage />
    case 'session':
      return (
        <ReviewEditor key={route.sessionId} sessionId={route.sessionId} onBack={closeSession} />
      )
    case 'settings':
      return <Settings subpage={route.subpage} onSubpageChange={openSubpage} />
    case 'dossiers':
    case 'dossier':
      // Patientendossiers folgen mit #204; nichts in der Oberfläche führt bisher hierher
      return (
        <PageContainer>
          <PageHeader title="Patientendossiers" />
          <p className="text-sm text-text-secondary">Diese Seite ist noch nicht verfügbar.</p>
        </PageContainer>
      )
  }
}
