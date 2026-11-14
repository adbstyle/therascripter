import { useCallback, useEffect, useRef, useState } from 'react'
import { isModalDialogOpen } from '../navigation/navigation'

/**
 * Seitenleiste ein-/ausgeblendet (Epic #192). Gespeichert in electron-store
 * (`sidebarOpen`, nicht schutzbedürftig); der Preload liest den Wert synchron
 * vor dem ersten Render (`nav.initialSidebarOpen`, wie `viewMode.initial`),
 * damit die Leiste beim Start nicht aufblitzt. Umschaltbar über den Knopf in
 * der Titelleiste und das Menü (⌃⌘S → `nav:command`).
 */
export function useSidebarOpen(): { sidebarOpen: boolean; toggleSidebar: () => void } {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.api.nav.initialSidebarOpen !== false)
  const openRef = useRef(sidebarOpen)

  const toggleSidebar = useCallback(() => {
    const next = !openRef.current
    openRef.current = next
    setSidebarOpen(next)
    window.api.settings.set('sidebarOpen', next).catch(() => {})
  }, [])

  useEffect(
    () =>
      window.api.nav.onCommand((command) => {
        if (command === 'toggleSidebar' && !isModalDialogOpen()) toggleSidebar()
      }),
    [toggleSidebar]
  )

  return { sidebarOpen, toggleSidebar }
}
