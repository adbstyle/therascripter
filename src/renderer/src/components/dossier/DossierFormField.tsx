import { forwardRef, useId } from 'react'

interface DossierFormFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  required?: boolean
  /** Meldung unter dem Feld; macht das Feld `aria-invalid`. */
  error?: string
  placeholder?: string
  maxLength?: number
  /** Mehrzeiliger Freitext (Diagnosen, Medikation, Notiz) mit dieser Zeilenzahl. */
  rows?: number
  /** Zusätzliche Beschreibung, z. B. das Eingabeformat. */
  hint?: string
  inputMode?: 'text' | 'numeric'
  autoComplete?: string
}

const CONTROL_CLASSES =
  'rounded-md border bg-surface-0 px-2 py-1.5 text-sm font-normal text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary'

/**
 * Beschriftetes Eingabefeld der Dossier-Formulare (Anlegen-Dialog, Stammdaten)
 * mit Meldung per `aria-describedby`/`aria-invalid`.
 */
export const DossierFormField = forwardRef<
  HTMLInputElement & HTMLTextAreaElement,
  DossierFormFieldProps
>(function DossierFormField(
  {
    label,
    value,
    onChange,
    onBlur,
    required,
    error,
    placeholder,
    maxLength,
    rows,
    hint,
    inputMode,
    autoComplete = 'off'
  },
  ref
) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')
  const common = {
    id,
    value,
    placeholder,
    maxLength,
    onBlur,
    'aria-required': required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    className: `${CONTROL_CLASSES} ${error ? 'border-error-text' : 'border-border-strong'}`
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5">
            *
          </span>
        )}
      </label>
      {rows ? (
        <textarea
          ref={ref}
          rows={rows}
          {...common}
          className={`${common.className} resize-y leading-5`}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          ref={ref}
          type="text"
          inputMode={inputMode}
          autoComplete={autoComplete}
          spellCheck={false}
          {...common}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      )}
      {error && (
        <p id={errorId} className="text-xs leading-4 text-error-text">
          {error}
        </p>
      )}
    </div>
  )
})
