import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays } from 'lucide-react'
import { DocumentDateDialog } from './DocumentDateDialog'
import { documentDateInfo, documentDateLabel } from '../../utils/sessionDates'
import type { Session } from '../../../../shared/types'

interface DocumentDateButtonProps {
  session: Pick<Session, 'id' | 'createdAt' | 'documentDate'>
  /** Titel in der gewählten Ansicht (für den Dialog). */
  sessionLabel: string
  /** Nach erfolgreichem Speichern (der Editor hält das Datum lokal). */
  onSaved?: (documentDate: string) => void
  /** Meldet, ob der Dialog offen ist (der Editor hält dann Esc zurück). */
  onOpenChange?: (open: boolean) => void
  className?: string
}

/**
 * Dokumentdatum eines PDF-Dokuments als Knopf: «02.11.2026» bzw.
 * «08.11.2026 · Importdatum», solange keines festgelegt ist (#205 AK 20).
 * Öffnet den Dialog zum Festlegen und Ändern (AK 18).
 */
export function DocumentDateButton({
  session,
  sessionLabel,
  onSaved,
  onOpenChange,
  className = ''
}: DocumentDateButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const info = documentDateInfo(session)

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={
          info.isSet
            ? `Dokumentdatum ${info.date} ändern`
            : `Dokumentdatum festlegen, es gilt das Importdatum ${info.importDate}`
        }
        title={info.isSet ? 'Dokumentdatum ändern' : 'Dokumentdatum festlegen'}
        className={`pointer-events-auto inline-flex items-center gap-1 whitespace-nowrap rounded text-xs text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      >
        <CalendarDays className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
        {documentDateLabel(session)}
      </button>
      {/* Portal: die Karten sind `pointer-events-none` (Klickfläche über der Karte) */}
      {open &&
        createPortal(
          <DocumentDateDialog
            session={session}
            sessionLabel={sessionLabel}
            onClose={() => setOpen(false)}
            onSaved={onSaved}
          />,
          document.body
        )}
    </>
  )
}
