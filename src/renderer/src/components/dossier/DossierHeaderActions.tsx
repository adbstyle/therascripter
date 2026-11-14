import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FileUp, Mic, MoreHorizontal, Search, Trash2 } from 'lucide-react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useNavigation } from '../../navigation/navigation'
import { useToast } from '../../hooks/useToast'
import { useRecordingState } from '../../contexts/recording'
import { useWorkspaceActions } from '../../contexts/workspaceActions'
import { discardDossierDraft } from '../../stores/dossierDrafts'
import { DeleteDossierDialog } from './DeleteDossierDialog'

interface DossierHeaderActionsProps {
  dossierId: string
  /** «Nachname, Vorname» — für den Hinweis, falls die Zuordnung scheitert (#206 AK 2). */
  dossierName?: string
}

/**
 * Aktionen im Kopf der Dossier-Seite: «Im Dossier suchen» (#211), «PDF importieren» und «Aufnahme
 * starten» ordnen das Neue diesem Dossier zu (#206) — die App bleibt dabei
 * auf der Seite, der Verlauf zeigt die Live-Karte bzw. die neuen PDFs. Dazu
 * das Menü «Weitere Aktionen» mit «Patientendossier löschen» (#204) —
 * Löschen liegt bewusst nicht als eigener Knopf neben den Hauptaktionen.
 * Während einer Aufnahme fehlt «Aufnahme starten» wie auf der Sitzungsliste:
 * eine zweite Aufnahme gibt es nicht.
 */
export function DossierHeaderActions({
  dossierId,
  dossierName
}: DossierHeaderActionsProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const { navigate } = useNavigation()
  const toast = useToast()
  const { isRecording } = useRecordingState()
  const { startRecording, importPdfs, isImporting } = useWorkspaceActions()

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
      {/* Suche nur in diesem Dossier (#211) */}
      <button
        type="button"
        onClick={() => navigate({ kind: 'dossierSearch', dossierId })}
        className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-0 px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        Im Dossier suchen
      </button>
      <button
        type="button"
        onClick={() => void importPdfs(undefined, { dossierId, dossierName })}
        disabled={isImporting}
        className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface-0 px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
      >
        <FileUp className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        PDF importieren
      </button>
      {!isRecording && (
        <button
          type="button"
          onClick={() => void startRecording({ dossierId, dossierName })}
          className="flex items-center gap-1.5 rounded-lg bg-recording-solid px-3.5 py-[7px] text-sm font-medium text-white transition-colors hover:bg-recording-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <Mic className="h-4 w-4" strokeWidth={2} aria-hidden />
          Aufnahme starten
        </button>
      )}
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
