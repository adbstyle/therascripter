import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Seitenleiste ein-/ausgeblendet (Epic #192). Gespeichert in electron-store
 * (`sidebarOpen`, nicht schutzbedürftig); umschaltbar über den Knopf in der
 * Titelleiste und das Menü (⌃⌘S → `nav:command`).
 */
export function useSidebarOpen(): { sidebarOpen: boolean; toggleSidebar: () => void } {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const openRef = useRef(true)
  const touched = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings
      .get('sidebarOpen')
      .then((value) => {
        // Ein schneller Klick vor der Antwort gewinnt gegen den gespeicherten Wert
        if (cancelled || touched.current || typeof value !== 'boolean') return
        openRef.current = value
        setSidebarOpen(value)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const toggleSidebar = useCallback(() => {
    touched.current = true
    const next = !openRef.current
    openRef.current = next
    setSidebarOpen(next)
    window.api.settings.set('sidebarOpen', next).catch(() => {})
  }, [])

  useEffect(
    () =>
      window.api.nav.onCommand((command) => {
        if (command === 'toggleSidebar') toggleSidebar()
      }),
    [toggleSidebar]
  )

  return { sidebarOpen, toggleSidebar }
}
