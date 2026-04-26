import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { PlaceholderType } from '../../../shared/types'
import { useClickOutside } from '../hooks/useClickOutside'

interface PlaceholderTypeDropdownProps {
  value: PlaceholderType
  onChange: (type: PlaceholderType) => void
}

const PLACEHOLDER_TYPES: Array<{ value: PlaceholderType; label: string }> = [
  { value: 'PERSON', label: 'Person' },
  { value: 'ORT', label: 'Ort' },
  { value: 'DATUM', label: 'Datum' },
  { value: 'KONTAKT', label: 'Kontakt' },
  { value: 'ORGANISATION', label: 'Organisation' },
  { value: 'MEDIZINISCH', label: 'Medizinisch' },
  { value: 'SONSTIGES', label: 'Sonstiges' }
]

export function PlaceholderTypeDropdown({
  value,
  onChange
}: PlaceholderTypeDropdownProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useClickOutside(dropdownRef, () => setIsOpen(false))

  const currentLabel = PLACEHOLDER_TYPES.find((t) => t.value === value)?.label ?? 'Person'

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-lg border border-border-strong bg-surface-0 px-3 py-2 text-sm text-text-primary hover:border-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{currentLabel}</span>
        <ChevronDown
          className={`h-4 w-4 text-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-surface-1 py-1 shadow-lg">
          {PLACEHOLDER_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface-2 ${
                type.value === value ? 'bg-primary-light text-primary' : 'text-text-primary'
              }`}
              onClick={() => {
                onChange(type.value)
                setIsOpen(false)
              }}
            >
              {type.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
