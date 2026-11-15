import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { DossierFormField } from './DossierFormField'
import { DuplicateNameNotice } from './DuplicateNameNotice'
import {
  DOSSIER_GONE_ERROR,
  dossierMaxLength,
  type DossierField,
  type DossierSaveStatus
} from '../../stores/dossierDrafts'
import type { DossierAutosave } from '../../hooks/useDossierAutosave'

const STATUS_TEXT: Record<DossierSaveStatus, string> = {
  saved: 'Gespeichert',
  saving: 'Wird gespeichert …',
  error: 'Nicht gespeichert'
}

interface DossierMasterDataFormProps {
  autosave: DossierAutosave
}

/**
 * Stammdaten rechts auf der Dossier-Seite (#204 AK 3/4/9–11): alle Angaben
 * einsehen und ändern, ohne Speichern-Knopf. Der Status steht in einer
 * `aria-live`-Region; Meldungen hängen per `aria-describedby` am Feld.
 */
export function DossierMasterDataForm({ autosave }: DossierMasterDataFormProps): React.JSX.Element {
  const { state, change, commit, retry } = autosave
  const announcement = useSaveAnnouncement(state.status)
  // Ein neues bzw. unverändertes Dossier zeigt keinen Status — «Gespeichert»
  // erst nach der ersten Änderung (Sichtprüfung); Fehler immer
  const [edited, setEdited] = useState(false)
  useEffect(() => {
    if (state.status !== 'saved') setEdited(true)
  }, [state.status])
  const showStatus = edited || state.status !== 'saved'
  const field = (
    key: DossierField
  ): {
    value: string
    error: string | undefined
    maxLength: number
    onChange: (value: string) => void
    onBlur: () => void
  } => ({
    value: state.values[key],
    error: state.errors[key],
    maxLength: dossierMaxLength(key),
    onChange: (value) => {
      setEdited(true)
      change(key, value)
    },
    onBlur: () => commit(key)
  })

  return (
    <aside
      aria-label="Stammdaten"
      className="flex min-w-0 max-w-[380px] flex-[1_1_300px] flex-col gap-3.5 rounded-xl border border-border bg-surface-1 p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Stammdaten</h2>
        {/* Sichtbarer Status — bewusst ausserhalb der Live-Region: «Wird
            gespeichert …» bei jedem Tastendruck anzusagen, störte beim Tippen */}
        <span
          data-save-status={state.status}
          hidden={!showStatus}
          className={`inline-flex items-center gap-1 text-xs ${
            state.status === 'error' ? 'text-error-text' : 'text-text-secondary'
          }`}
        >
          {state.status === 'saved' && (
            <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          )}
          {state.status === 'error' && (
            <AlertCircle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          )}
          {STATUS_TEXT[state.status]}
        </span>
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </div>

      {state.technicalError && (
        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs leading-[18px] text-error-text-emphasis"
        >
          <p>{state.technicalError}</p>
          {state.technicalError !== DOSSIER_GONE_ERROR && (
            <button
              type="button"
              onClick={retry}
              className="self-start font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Erneut versuchen
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <DossierFormField label="Vorname" required {...field('firstName')} />
        <DossierFormField label="Nachname" required {...field('lastName')} />
        <DossierFormField label="Dossier-ID" {...field('externalId')} />
        <DossierFormField
          label="Geburtsdatum"
          placeholder="TT.MM.JJJJ"
          hint="Format TT.MM.JJJJ"
          inputMode="numeric"
          {...field('birthDate')}
        />
      </div>

      <DuplicateNameNotice
        duplicates={state.duplicates}
        followUp="Die Änderung ist trotzdem gespeichert."
      />

      <DossierFormField label="Diagnosen" rows={2} {...field('diagnoses')} />
      <DossierFormField label="Medikation" rows={2} {...field('medication')} />
      <DossierFormField label="Notiz" rows={3} {...field('note')} />

      <p className="text-xs leading-[17px] text-text-secondary">
        Änderungen werden laufend gespeichert und bleiben lokal auf diesem Mac, bis Sie das Dossier
        löschen.
      </p>
    </aside>
  )
}

/**
 * Text der Live-Region: angesagt wird nur der Wechsel auf «Nicht gespeichert»
 * und danach zurück auf «Gespeichert» — nicht jedes «Wird gespeichert …» und
 * nicht der Ausgangszustand.
 */
function useSaveAnnouncement(status: DossierSaveStatus): string {
  const [announcement, setAnnouncement] = useState('')
  const lastRef = useRef('')
  useEffect(() => {
    let next = lastRef.current
    if (status === 'error') next = STATUS_TEXT.error
    else if (status === 'saved' && lastRef.current === STATUS_TEXT.error) next = STATUS_TEXT.saved
    if (next !== lastRef.current) {
      lastRef.current = next
      setAnnouncement(next)
    }
  }, [status])
  return announcement
}
