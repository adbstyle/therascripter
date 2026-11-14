import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useNavigation } from '../../navigation/navigation'
import { useToast } from '../../hooks/useToast'
import { discardDossierDraft } from '../../stores/dossierDrafts'
import { DeleteDossierDialog } from './DeleteDossierDialog'

interface DossierHeaderActionsProps {
  dossierId: string
}

/**
 * Aktionen im Kopf der Dossier-Seite. In #204 nur das Menü «Weitere Aktionen»
 * mit «Patientendossier löschen» — Löschen liegt bewusst nicht als eigener
 * Knopf neben den Hauptaktionen. #206 ergänzt hier «PDF importieren» und
 * «Aufnahme starten».
 */
export function DossierHeaderActions({ dossierId }: DossierHeaderActionsProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const { navigate } = useNavigation()
  const toast = useToast()

  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useClickOutside(menuRef, closeMenu)

  useEffect(() => {
    if (menuOpen) itemRef.current?.focus()
  }, [menuOpen])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setMenuOpen(false)
      triggerRef.current?.focus()
    } else if (event.key === 'Tab') {
      setMenuOpen(false)
    }
  }

  function askDelete(): void {
    // Der Dialog gibt den Fokus beim Schliessen an «Weitere Aktionen» zurück
    triggerRef.current?.focus()
    setMenuOpen(false)
    setDeleting(true)
  }

  const onDeleted = useCallback(() => {
    setDeleting(false)
    discardDossierDraft(dossierId)
    navigate({ kind: 'dossiers' }, { replace: true })
    toast.success('Patientendossier gelöscht')
  }, [dossierId, navigate, toast])

  return (
    <>
      <div ref={menuRef} className="relative" onKeyDown={onMenuKeyDown}>
        <button
          ref={triggerRef}
          type="button"
          aria-label="Weitere Aktionen"
          title="Weitere Aktionen"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <MoreHorizontal className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>
        {menuOpen && (
          <div
            role="menu"
            aria-label="Weitere Aktionen"
            className="absolute right-0 top-full z-20 mt-1 min-w-[220px] rounded-lg border border-border bg-surface-0 p-1 shadow-lg"
          >
            <button
              ref={itemRef}
              type="button"
              role="menuitem"
              onClick={askDelete}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-error-text hover:bg-error-bg focus-visible:bg-error-bg focus-visible:outline-none"
            >
              <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
              Patientendossier löschen
            </button>
          </div>
        )}
      </div>
      {deleting && (
        <DeleteDossierDialog
          dossierId={dossierId}
          onClose={() => setDeleting(false)}
          onDeleted={onDeleted}
        />
      )}
    </>
  )
}
