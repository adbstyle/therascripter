import { useRef, useState } from 'react'
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
        className="flex w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 hover:border-gray-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{currentLabel}</span>
        <svg
          className={`h-4 w-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {PLACEHOLDER_TYPES.map((type) => (
            <button
              key={type.value}
              type="button"
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                type.value === value ? 'bg-blue-50 text-primary' : 'text-gray-900'
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
