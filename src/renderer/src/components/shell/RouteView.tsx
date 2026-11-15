import { useCallback } from 'react'
import { useNavigation } from '../../navigation/navigation'
import { HOME_ROUTE, type SubPage } from '../../navigation/routes'
import SessionsPage from '../../views/SessionsPage'
import ReviewEditor from '../../views/ReviewEditor'
import Settings from '../../views/Settings'
import DossiersPage from '../../views/DossiersPage'
import DossierPage from '../../views/DossierPage'
import DossierSearchPage from '../../views/DossierSearchPage'

/** Rendert die Seite der aktuellen Route (Epic #192). */
export default function RouteView(): React.JSX.Element {
  const { route, entryId, navigate, back, consumeFocus } = useNavigation()

  // Esc und «Zurück» im Editor: nur wenn der Editor noch die aktuelle Seite
  // ist (das Löschen kann den Eintrag schon entfernt haben), sonst
  // Sitzungsliste, falls der Verlauf zurück nichts hergibt.
  const closeSession = useCallback(
    () => back({ fromEntryId: entryId, fallback: HOME_ROUTE }),
    [back, entryId]
  )
  // Die Fundstelle gilt einmal: bei einer späteren Rückkehr keine zweite Meldung
  const focusConsumed = useCallback(() => consumeFocus(entryId), [consumeFocus, entryId])
  const openDossier = useCallback(
    (dossierId: string) => navigate({ kind: 'dossier', dossierId }),
    [navigate]
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
        <ReviewEditor
          key={route.sessionId}
          sessionId={route.sessionId}
          focus={route.focus}
          onFocusConsumed={focusConsumed}
          onBack={closeSession}
          onOpenDossier={openDossier}
        />
      )
    case 'settings':
      return <Settings subpage={route.subpage} onSubpageChange={openSubpage} />
    case 'dossiers':
      return <DossiersPage />
    case 'dossier':
      return <DossierPage key={route.dossierId} dossierId={route.dossierId} />
    case 'dossierSearch':
      return <DossierSearchPage key={route.dossierId} dossierId={route.dossierId} />
  }
}
