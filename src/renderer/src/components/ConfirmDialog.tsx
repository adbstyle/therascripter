import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  message: string
  details?: string[]
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()

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
      aria-label={title}
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-base font-semibold text-gray-900">{title}</h3>
        <p className="mb-4 text-sm text-gray-600">{message}</p>

        {details && details.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 text-xs font-medium text-gray-500">Gelöscht werden:</p>
            <ul className="list-inside list-disc text-xs text-gray-500">
              {details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </div>
        )}

        <p className="mb-4 text-xs text-gray-400">
          Diese Aktion kann nicht rückgängig gemacht werden.
        </p>

        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-blue-700'
            }`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
