import { useEffect, useSyncExternalStore } from 'react'
import { useNavigation } from '../../navigation/navigation'
import {
  closeSearchModal,
  openSearchModal,
  purgeDeletedDossiers,
  purgeDeletedSessions,
  searchModalOpen
} from '../../stores/searchSession'
import { SearchModal } from './SearchModal'

/**
 * Trägt das Suchfenster in der App-Shell (#209): öffnet es über ⌘K
 * (`nav:command 'search'`, schaltet um) und wieder, wenn ‹ / Esc zu dem
 * Verlaufseintrag zurückführt, aus dem ein Treffer geöffnet wurde
 * (`reopenOverlay`, AK 12). Entfernt gelöschte Sitzungen und Dossiers aus
 * den gemerkten Treffern — auch solange das Fenster zu ist.
 *
 * Lebt nur in der Shell: während der Ersteinrichtung gibt es keine Suche.
 */
export function SearchHost(): React.JSX.Element | null {
  const open = useSyncExternalStore(searchModalOpen.subscribe, searchModalOpen.get)
  const { entryId, reopenOverlay, consumeOverlay } = useNavigation()

  useEffect(
    () =>
      window.api.nav.onCommand((command) => {
        if (command !== 'search') return
        if (searchModalOpen.get()) closeSearchModal()
        else openSearchModal()
      }),
    []
  )

  // ⌘, bzw. Tray «Einstellungen…»: die Einstellungen öffnen, das Fenster schliesst
  useEffect(() => window.api.nav.onOpenSettings(() => closeSearchModal('navigate')), [])

  useEffect(() => {
    if (reopenOverlay !== 'search') return
    consumeOverlay(entryId)
    openSearchModal()
  }, [reopenOverlay, entryId, consumeOverlay])

  useEffect(
    () => window.api.sessions.onChanged(({ deletedIds }) => purgeDeletedSessions(deletedIds)),
    []
  )
  useEffect(
    () => window.api.dossiers.onChanged(({ deletedIds }) => purgeDeletedDossiers(deletedIds)),
    []
  )

  return open ? <SearchModal onClose={closeSearchModal} /> : null
}
