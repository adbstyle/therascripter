import { useEffect, useRef, useState } from 'react'
import { DialogShell } from '../DialogShell'
import { useLiveQuery } from '../../hooks/useLiveQuery'
import { useRecordingState } from '../../contexts/recording'
import { summarizeDeletion } from '../../utils/dossierDeletion'
import { useAmbiguousDossierNames } from '../../stores/dossierNames'
import type { DossierDeletePreview } from '../../../../shared/types/Dossier'

interface DeleteDossierDialogProps {
  dossierId: string
  onClose: () => void
  /** Gelöscht; die Seite führt zur Übersicht. */
  onDeleted: () => void
}

const DELETE_FAILED =
  'Das Patientendossier konnte nicht gelöscht werden. Es ist unverändert vorhanden — bitte versuchen Sie es erneut.'
const LOAD_FAILED = 'Die Angaben zum Löschen konnten nicht geladen werden.'
const CHANGED_NOTICE =
  'Inzwischen hat sich geändert, was mitgelöscht würde. Gelöscht wurde nichts — bitte prüfen Sie die aktuellen Angaben.'

const SECONDARY_BUTTON =
  'rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50'
const PRIMARY_BUTTON =
  'rounded-lg bg-primary-solid px-4 py-2 text-sm font-medium text-white hover:bg-primary-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2'
const DESTRUCTIVE_BUTTON =
  'rounded-lg bg-recording-solid px-4 py-2 text-sm font-medium text-white hover:bg-recording-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:opacity-50'

/**
 * Bestätigung zum Löschen eines Patientendossiers. Lädt die Vorschau beim
 * Öffnen und bei jedem `sessions:changed`/`dossiers:changed` neu, solange der
 * Dialog offen ist; gelöscht wird nur der Stand, den der USER gesehen hat
 * (Fingerprint). Antwortet der Main-Prozess mit `changed`, ersetzt der Dialog
 * die Zahlen, ohne zu löschen. Bei laufender, nur diesem Dossier zugeordneter
 * Aufnahme nennt er den Grund (#207 AK 2). Scheitert das Löschen, bleibt der
 * Dialog mit Meldung offen (#204 AK 11).
 */
export function DeleteDossierDialog({
  dossierId,
  onClose,
  onDeleted
}: DeleteDossierDialogProps): React.JSX.Element {
  const { isRecording, stopRecording } = useRecordingState()
  const ambiguous = useAmbiguousDossierNames()
  const preview = useLiveQuery<DossierDeletePreview | null>(
    () => window.api.dossiers.deletePreview(dossierId),
    [
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    null
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [changedNotice, setChangedNotice] = useState(false)
  const [gone, setGone] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const data = preview.data
  const blocked = data?.blockedByRecording === true
  const view: 'loading' | 'load-error' | 'gone' | 'blocked' | 'confirm' = gone
    ? 'gone'
    : data
      ? blocked
        ? 'blocked'
        : 'confirm'
      : preview.loading
        ? 'loading'
        : preview.error
          ? 'load-error'
          : 'gone'

  // Fokus beim Öffnen und bei jedem Wechsel der Ansicht auf den sicheren Knopf
  useEffect(() => {
    cancelRef.current?.focus()
  }, [view])

  async function confirm(): Promise<void> {
    if (!data || busy) return
    setBusy(true)
    setFailure(null)
    setChangedNotice(false)
    try {
      const result = await window.api.dossiers.delete(dossierId, data.fingerprint)
      if (!mounted.current) return
      if (result.ok) {
        onDeleted()
        return
      }
      if (result.reason === 'changed') {
        preview.setData(result.preview)
        setChangedNotice(true)
      } else if (result.reason === 'blocked-recording') {
        preview.setData({ ...data, blockedByRecording: true })
        void preview.refresh()
      } else {
        setGone(true)
      }
    } catch (error) {
      console.error('[DeleteDossierDialog] Löschen fehlgeschlagen:', error)
      if (mounted.current) setFailure(DELETE_FAILED)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const summary = data ? summarizeDeletion(data, ambiguous) : null
  const ariaLabel =
    view === 'blocked'
      ? 'Patientendossier kann gerade nicht gelöscht werden'
      : (summary?.title ?? 'Patientendossier löschen')

  return (
    <DialogShell ariaLabel={ariaLabel} onDismiss={busy ? () => undefined : onClose}>
      {view === 'blocked' && data && (
        <>
          <h3 className="mb-2 text-base font-semibold text-text-primary">
            Patientendossier kann gerade nicht gelöscht werden
          </h3>
          <p className="mb-4 text-sm text-text-secondary">
            Für {data.displayName} läuft eine Aufnahme, die nur diesem Dossier zugeordnet ist.
            Stoppen Sie die Aufnahme, dann lässt sich das Dossier löschen.
          </p>
          <div className="flex justify-end gap-2">
            <button ref={cancelRef} type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              Schliessen
            </button>
            {isRecording && (
              <button
                type="button"
                className={DESTRUCTIVE_BUTTON}
                onClick={() => void stopRecording()}
              >
                Aufnahme stoppen
              </button>
            )}
          </div>
        </>
      )}

      {view === 'confirm' && summary && (
        <>
          <h3 className="mb-2 text-base font-semibold text-text-primary">{summary.title}</h3>
          <p className="mb-4 text-sm text-text-secondary">{summary.message}</p>
          {summary.sections.map((section) => (
            <div key={section.heading} className="mb-4">
              <p className="mb-1 text-xs font-medium text-text-tertiary">{section.heading}</p>
              <ul className="list-inside list-disc text-xs text-text-tertiary">
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
          {changedNotice && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
            >
              {CHANGED_NOTICE}
            </p>
          )}
          {failure && (
            <p role="alert" className="mb-4 text-sm text-error-text">
              {failure}
            </p>
          )}
          <p className="mb-4 text-xs text-text-tertiary">
            Diese Aktion kann nicht rückgängig gemacht werden.
          </p>
          <div className="flex justify-end gap-2">
            <button
              ref={cancelRef}
              type="button"
              className={SECONDARY_BUTTON}
              onClick={onClose}
              disabled={busy}
            >
              Abbrechen
            </button>
            <button
              type="button"
              className={DESTRUCTIVE_BUTTON}
              onClick={() => void confirm()}
              disabled={busy}
            >
              {busy ? 'Wird gelöscht …' : summary.confirmLabel}
            </button>
          </div>
        </>
      )}

      {(view === 'loading' || view === 'load-error' || view === 'gone') && (
        <>
          <h3 className="mb-2 text-base font-semibold text-text-primary">
            Patientendossier löschen
          </h3>
          <p
            role={view === 'loading' ? undefined : 'alert'}
            className="mb-4 text-sm text-text-secondary"
          >
            {view === 'loading'
              ? 'Wird geladen …'
              : view === 'load-error'
                ? LOAD_FAILED
                : 'Dieses Patientendossier gibt es nicht mehr.'}
          </p>
          <div className="flex justify-end gap-2">
            <button ref={cancelRef} type="button" className={SECONDARY_BUTTON} onClick={onClose}>
              {view === 'loading' ? 'Abbrechen' : 'Schliessen'}
            </button>
            {view === 'load-error' && (
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => void preview.refresh()}
              >
                Erneut versuchen
              </button>
            )}
          </div>
        </>
      )}
    </DialogShell>
  )
}
