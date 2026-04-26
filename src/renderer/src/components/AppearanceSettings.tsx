import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import type { ThemePreference } from '../contexts/themeTypes'

const THEME_OPTIONS: Array<{
  id: ThemePreference
  label: string
  description: string
  Icon: LucideIcon
}> = [
  { id: 'light', label: 'Hell', description: 'Immer heller Modus', Icon: Sun },
  {
    id: 'system',
    label: 'System',
    description: 'Folgt der macOS-Einstellung',
    Icon: Monitor
  },
  { id: 'dark', label: 'Dunkel', description: 'Immer dunkler Modus', Icon: Moon }
]

export default function AppearanceSettings(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <div className="p-8">
      <h3 className="mb-1 text-sm font-semibold text-text-primary">Erscheinungsbild</h3>
      <p className="mb-6 text-sm text-text-tertiary">
        Bestimmt, ob TheraScript im hellen oder dunklen Modus angezeigt wird.
      </p>

      <div className="flex gap-4">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            className={`flex w-36 flex-col items-center gap-2 rounded-xl border-2 px-4 py-5 transition-colors ${
              theme === option.id
                ? 'border-primary bg-primary-light'
                : 'border-border bg-surface-1 hover:border-border-strong'
            }`}
            onClick={() => setTheme(option.id)}
          >
            <option.Icon
              className={`h-7 w-7 ${theme === option.id ? 'text-primary' : 'text-text-secondary'}`}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-text-primary">{option.label}</span>
            <span className="text-center text-xs text-text-tertiary">{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
