import { useEffect, useRef, useState } from 'react'

interface RenameDialogProps {
  currentTitle: string
  onConfirm: (title: string) => void
  onCancel: () => void
}

export function RenameDialog({
  currentTitle,
  onConfirm,
  onCancel
}: RenameDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(currentTitle)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length > 0) {
      onConfirm(trimmed)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Transkription umbenennen"
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl bg-surface-1 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-text-primary">Transkription umbenennen</h3>

        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mb-4 w-full rounded-lg border border-border-strong bg-surface-0 px-3 py-2 text-sm text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            maxLength={200}
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
              onClick={onCancel}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
              disabled={title.trim().length === 0}
            >
              Umbenennen
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
