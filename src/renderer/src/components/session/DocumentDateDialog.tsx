import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DialogShell } from '../DialogShell'
import { DossierFormField } from '../dossier/DossierFormField'
import { formatSwissDate } from '../../../../shared/utils/calendar-date'
import { documentDateInfo, validateDocumentDate } from '../../utils/sessionDates'
import type { Session } from '../../../../shared/types'

interface DocumentDateDialogProps {
  session: Pick<Session, 'id' | 'createdAt' | 'documentDate'>
  /** Titel in der gewählten Ansicht. */
  sessionLabel: string
  onClose: () => void
  /** Nach erfolgreichem Speichern mit dem neuen ISO-Tag. */
  onSaved?: (documentDate: string) => void
}

/**
 * Dokumentdatum eines PDF-Dokuments festlegen oder ändern (#205 AK 18–21).
 * Bewusst ohne «Importdatum verwenden»: ein festgelegtes Datum lässt sich
 * ändern, aber nicht zurücksetzen (OOS 3). Schlägt das Speichern fehl, bleibt
 * der Dialog mit Meldung offen und das bisherige Datum gilt weiter (AK 24, PC 3).
 */
export function DocumentDateDialog({
  session,
  sessionLabel,
  onClose,
  onSaved
}: DocumentDateDialogProps): React.JSX.Element {
  const info = documentDateInfo(session)
  const [value, setValue] = useState(
    session.documentDate ? formatSwissDate(session.documentDate) : ''
  )
  const [error, setError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    const result = validateDocumentDate(value)
    if ('error' in result) {
      setError(result.error)
      inputRef.current?.focus()
      return
    }
    setError(undefined)
    setSaveError(null)
    setSaving(true)
    let ok = false
    try {
      ok = (await window.api.sessions.setDocumentDate(session.id, result.iso)).ok
    } catch {
      ok = false
    }
    setSaving(false)
    if (!ok) {
      setSaveError(
        'Das Dokumentdatum konnte nicht gespeichert werden. Das bisherige Datum gilt weiter.'
      )
      return
    }
    onSaved?.(result.iso)
    onClose()
  }

  return (
    <DialogShell ariaLabel="Dokumentdatum festlegen" onDismiss={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void onSubmit(e)} noValidate>
        <h3 className="text-base font-semibold text-text-primary">Dokumentdatum festlegen</h3>
        <p className="text-sm text-text-secondary">
          Das Dokumentdatum bestimmt die Stelle von «{sessionLabel}» im Verlauf der
          Patientendossiers. Importiert am {info.importDate}.
          {!info.isSet && ' Solange Sie keines festlegen, gilt das Importdatum.'}
        </p>
        <DossierFormField
          ref={inputRef}
          label="Dokumentdatum"
          value={value}
          onChange={(next) => {
            setValue(next)
            setError(undefined)
          }}
          error={error}
          placeholder="TT.MM.JJJJ"
          hint="Format TT.MM.JJJJ, nicht nach heute"
          inputMode="numeric"
          maxLength={10}
        />
        {saveError && (
          <p role="alert" className="text-sm text-error-text">
            {saveError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-primary-solid px-4 py-2 text-sm font-medium text-white hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
          >
            Übernehmen
          </button>
        </div>
      </form>
    </DialogShell>
  )
}
