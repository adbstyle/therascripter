import { Eye, EyeOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ViewMode } from '../../../../shared/types/ViewMode'
import { useViewMode } from '../../viewMode/useViewMode'
import { setViewMode } from '../../viewMode/viewModeStore'

const OPTIONS: Array<{ mode: ViewMode; label: string; hint: string; icon: LucideIcon }> = [
  {
    mode: 'pseudonymized',
    label: 'Pseudonymisiert',
    hint: 'Sitzungen mit Platzhaltern anzeigen und kopieren',
    icon: EyeOff
  },
  {
    mode: 'plain',
    label: 'Klartext',
    hint: 'Sitzungen mit den Originalnamen anzeigen und kopieren',
    icon: Eye
  }
]

/**
 * Issue #203 — global switch between the pseudonymized and the Klartext view
 * (AK 1). A segmented control rather than a single toggle: both views stay
 * named, the active one is highlighted and announced via aria-pressed, so
 * the current view is recognizable at any time (AK 2). Self-contained on
 * purpose — the app shell will move to a sidebar later.
 */
export function ViewModeToggle(): React.JSX.Element {
  const current = useViewMode()

  return (
    <div
      role="group"
      aria-label="Ansicht"
      className="titlebar-no-drag flex items-center gap-0.5 rounded-md border border-border bg-surface-1 p-0.5"
    >
      {OPTIONS.map(({ mode, label, hint, icon: Icon }) => {
        const active = current === mode
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            title={hint}
            onClick={() => {
              if (!active) setViewMode(mode)
            }}
            className={`flex h-6 items-center gap-1 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              active
                ? mode === 'plain'
                  ? 'bg-warning-bg text-warning-text shadow-sm'
                  : 'bg-surface-0 text-text-primary shadow-sm'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}
