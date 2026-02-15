import { useEffect, useRef, useState } from 'react'
import type { PlaceholderType } from '../../../shared/types'
import { PlaceholderTypeDropdown } from './PlaceholderTypeDropdown'

interface BlocklistDialogProps {
  mode: 'add' | 'edit'
  initialTerm?: string
  initialType?: PlaceholderType
  onConfirm: (term: string, type: PlaceholderType) => void
  onCancel: () => void
}

export function BlocklistDialog({
  mode,
  initialTerm = '',
  initialType = 'PERSON',
  onConfirm,
  onCancel
}: BlocklistDialogProps): React.JSX.Element {
  const [term, setTerm] = useState(initialTerm)
  const [type, setType] = useState<PlaceholderType>(initialType)
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
    const trimmed = term.trim()
    if (trimmed.length > 0 && trimmed.length <= 200) {
      onConfirm(trimmed, type)
    }
  }

  const isValid = term.trim().length > 0 && term.trim().length <= 200

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'add' ? 'Eintrag hinzufügen' : 'Eintrag bearbeiten'}
      onClick={onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-gray-900">
          {mode === 'add' ? 'Eintrag hinzufügen' : 'Eintrag bearbeiten'}
        </h3>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="blocklist-term" className="mb-1 block text-sm font-medium text-gray-700">
              Begriff
            </label>
            <input
              ref={inputRef}
              id="blocklist-term"
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              maxLength={200}
              autoFocus
            />
          </div>

          <div className="mb-6">
            <label className="mb-1 block text-sm font-medium text-gray-700">Platzhaltertyp</label>
            <PlaceholderTypeDropdown value={type} onChange={setType} />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
              onClick={onCancel}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!isValid}
            >
              {mode === 'add' ? 'Hinzufügen' : 'Speichern'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
