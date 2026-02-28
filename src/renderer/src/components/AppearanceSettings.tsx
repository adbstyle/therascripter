import { useTheme } from '../hooks/useTheme'
import type { ThemePreference } from '../contexts/themeTypes'

const THEME_OPTIONS: Array<{
  id: ThemePreference
  label: string
  description: string
  icon: string
}> = [
  { id: 'light', label: 'Hell', description: 'Immer heller Modus', icon: '\u2600\uFE0F' },
  {
    id: 'system',
    label: 'System',
    description: 'Folgt der macOS-Einstellung',
    icon: '\uD83D\uDDA5\uFE0F'
  },
  { id: 'dark', label: 'Dunkel', description: 'Immer dunkler Modus', icon: '\uD83C\uDF19' }
]

export default function AppearanceSettings(): React.JSX.Element {
  const { theme, setTheme } = useTheme()

  return (
    <div className="p-8">
      <h3 className="mb-1 text-sm font-semibold text-text-primary">Erscheinungsbild</h3>
      <p className="mb-6 text-sm text-text-tertiary">
        Bestimmt, ob Therascript im hellen oder dunklen Modus angezeigt wird.
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
            <span className="text-2xl">{option.icon}</span>
            <span className="text-sm font-medium text-text-primary">{option.label}</span>
            <span className="text-center text-xs text-text-tertiary">{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
