import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { DialogShell } from '../DialogShell'
import { DossierFormField } from './DossierFormField'
import { DuplicateNameNotice } from './DuplicateNameNotice'
import {
  dossierMaxLength,
  externalIdTakenMessage,
  validateDossierField,
  type DossierField
} from '../../stores/dossierDrafts'
import type { Dossier, DossierPatch, DossierRef } from '../../../../shared/types/Dossier'

type FormField = Extract<DossierField, 'firstName' | 'lastName' | 'externalId' | 'birthDate'>
type FormValues = Record<FormField, string>

const EMPTY: FormValues = { firstName: '', lastName: '', externalId: '', birthDate: '' }

const CREATE_FAILED =
  'Das Patientendossier konnte nicht angelegt werden. Ihre Eingaben bleiben erhalten — bitte versuchen Sie es erneut.'

interface NewDossierDialogProps {
  onClose: () => void
  onCreated: (dossier: Dossier) => void
}

/**
 * «Neues Patientendossier» (#204 AK 1–8): Vor- und Nachname Pflicht, Dossier-ID
 * und Geburtsdatum (TT.MM.JJJJ) freiwillig. Eine vergebene ID nennt den
 * Besitzer; gleiche Namen warnen einmal, danach legt «Trotzdem anlegen» an.
 */
export function NewDossierDialog({ onClose, onCreated }: NewDossierDialogProps): React.JSX.Element {
  const [values, setValues] = useState<FormValues>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({})
  const [duplicates, setDuplicates] = useState<DossierRef[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstNameRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const formRef = useRef<HTMLFormElement>(null)
  // Nach einem abgelehnten Absenden springt der Fokus ins erste fehlerhafte Feld
  const [errorFocusTick, setErrorFocusTick] = useState(0)

  useEffect(() => {
    if (errorFocusTick === 0) return
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [errorFocusTick])

  useEffect(() => {
    firstNameRef.current?.focus()
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  function change(field: FormField, value: string): void {
    setValues((prev) => ({ ...prev, [field]: value }))
    setErrors((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
    setFailure(null)
    // Ein anderer Name ist ein anderer Fall: der Hinweis gilt dann nicht mehr
    if (field === 'firstName' || field === 'lastName') setDuplicates([])
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const nextErrors: Partial<Record<FormField, string>> = {}
    const patch: DossierPatch = {}
    for (const field of ['firstName', 'lastName', 'externalId', 'birthDate'] as const) {
      const check = validateDossierField(field, values[field])
      if (check.ok) Object.assign(patch, check.patch)
      else nextErrors[field] = check.message
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      setErrorFocusTick((t) => t + 1)
      return
    }

    setBusy(true)
    setFailure(null)
    try {
      const result = await window.api.dossiers.create({
        firstName: patch.firstName as string,
        lastName: patch.lastName as string,
        externalId: patch.externalId ?? null,
        birthDate: patch.birthDate ?? null,
        confirmDuplicate: duplicates.length > 0
      })
      if (!mounted.current) return
      if (result.ok) {
        onCreated(result.dossier)
        return
      }
      if (result.reason === 'external-id-taken') {
        setErrors({ externalId: externalIdTakenMessage(values.externalId, result.ownerName) })
        setErrorFocusTick((t) => t + 1)
      } else {
        setDuplicates(result.duplicates)
      }
    } catch (error) {
      console.error('[NewDossierDialog] Anlegen fehlgeschlagen:', error)
      if (mounted.current) setFailure(CREATE_FAILED)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const field = (key: FormField): { value: string; onChange: (v: string) => void } => ({
    value: values[key],
    onChange: (v) => change(key, v)
  })

  return (
    <DialogShell
      ariaLabel="Neues Patientendossier"
      // Während des Anlegens weder Esc noch Klick daneben: sonst entstünde ein
      // Dossier, ohne dass die App dorthin führt
      onDismiss={busy ? () => undefined : onClose}
      size="lg"
    >
      <form
        ref={formRef}
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
      >
        <h3 className="text-base font-semibold text-text-primary">Neues Patientendossier</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DossierFormField
            ref={firstNameRef}
            label="Vorname"
            required
            maxLength={dossierMaxLength('firstName')}
            error={errors.firstName}
            {...field('firstName')}
          />
          <DossierFormField
            label="Nachname"
            required
            maxLength={dossierMaxLength('lastName')}
            error={errors.lastName}
            {...field('lastName')}
          />
          <DossierFormField
            label="Dossier-ID"
            maxLength={dossierMaxLength('externalId')}
            error={errors.externalId}
            {...field('externalId')}
          />
          <DossierFormField
            label="Geburtsdatum"
            placeholder="TT.MM.JJJJ"
            hint="Format TT.MM.JJJJ"
            inputMode="numeric"
            maxLength={dossierMaxLength('birthDate')}
            error={errors.birthDate}
            {...field('birthDate')}
          />
        </div>
        <p className="text-xs text-text-secondary">
          Diagnosen, Medikation und Notiz erfassen Sie danach im Dossier.
        </p>
        <DuplicateNameNotice
          duplicates={duplicates}
          followUp="Sie können trotzdem ein weiteres anlegen."
        />
        {failure && (
          <p role="alert" className="text-sm text-error-text">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-primary-solid px-4 py-2 text-sm font-medium text-white hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {duplicates.length > 0 ? 'Trotzdem anlegen' : 'Anlegen'}
          </button>
        </div>
      </form>
    </DialogShell>
  )
}
