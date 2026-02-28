import { useEffect, useRef } from 'react'
import type { PlaceholderType } from '../../../../shared/types'

const TYPE_LABELS: Record<PlaceholderType, string> = {
  PERSON: 'Person',
  ORT: 'Ort',
  DATUM: 'Datum',
  KONTAKT: 'Kontakt',
  ORGANISATION: 'Organisation',
  MEDIZINISCH: 'Medizinisch',
  SONSTIGES: 'Sonstiges'
}

interface BlocklistConfirmDialogProps {
  term: string
  type: PlaceholderType
  onConfirm: () => void
  onCancel: () => void
}

export function BlocklistConfirmDialog({
  term,
  type,
  onConfirm,
  onCancel
}: BlocklistConfirmDialogProps): React.JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirmRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Zur Sperrliste hinzufügen"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl bg-surface-1 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-base font-semibold text-text-primary">
          Zur Sperrliste hinzufügen
        </h3>
        <p className="mb-3 text-sm text-text-secondary">
          &bdquo;{term}&ldquo; als <span className="font-medium">{TYPE_LABELS[type]}</span> zur
          Sperrliste hinzufügen?
        </p>
        <p className="mb-4 text-xs text-text-tertiary">
          Der Begriff wird in zukünftigen Sitzungen automatisch anonymisiert und retroaktiv im
          aktuellen Dokument ersetzt.
        </p>

        <div className="flex justify-end gap-2">
          <button
            className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            ref={confirmRef}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            onClick={onConfirm}
          >
            Hinzufügen
          </button>
        </div>
      </div>
    </div>
  )
}
