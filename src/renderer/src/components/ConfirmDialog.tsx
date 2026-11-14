import { useEffect, useRef } from 'react'
import { DialogShell } from './DialogShell'

export interface ConfirmDialogSection {
  heading: string
  items: string[]
}

interface ConfirmDialogProps {
  title: string
  message: string
  /** Kurzform für einen einzigen Abschnitt «Gelöscht werden:». */
  details?: string[]
  /** Mehrere Abschnitte, z. B. «Gelöscht werden:» und «Erhalten bleiben:» (Epic #192). */
  sections?: ConfirmDialogSection[]
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  details,
  sections,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const allSections: ConfirmDialogSection[] = [
    ...(details && details.length > 0 ? [{ heading: 'Gelöscht werden:', items: details }] : []),
    ...(sections ?? []).filter((section) => section.items.length > 0)
  ]

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <DialogShell ariaLabel={title} onDismiss={onCancel}>
      <h3 className="mb-2 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mb-4 text-sm text-text-secondary">{message}</p>

      {allSections.map((section) => (
        <div key={section.heading} className="mb-4">
          <p className="mb-1 text-xs font-medium text-text-tertiary">{section.heading}</p>
          <ul className="list-inside list-disc text-xs text-text-tertiary">
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ))}

      <p className="mb-4 text-xs text-text-tertiary">
        Diese Aktion kann nicht rückgängig gemacht werden.
      </p>

      <div className="flex justify-end gap-2">
        <button
          ref={cancelRef}
          className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
          onClick={onCancel}
        >
          Abbrechen
        </button>
        <button
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
            destructive
              ? 'bg-recording-solid hover:bg-recording-solid-hover'
              : 'bg-primary hover:bg-primary-hover'
          }`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  )
}
