interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Sichtbarer Bezeichner steht daneben — hier der zugängliche Name. */
  label: string
  disabled?: boolean
}

/** Ein-/Aus-Schalter (role="switch"). */
export default function Toggle({
  checked,
  onChange,
  label,
  disabled
}: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`titlebar-no-drag relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-surface-3'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
