import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ViewModeToggle } from './ViewModeToggle'
import { useNavigation } from '../../navigation/navigation'
import { RECONCILE_HINT, useShellHints } from '../../hooks/useShellHints'
import { ReconcileDot, UpdateChip } from './ShellHints'

interface TitleBarProps {
  /** `minimal`: nur die Wortmarke (Ersteinrichtung, Ladezustand). */
  variant?: 'full' | 'minimal'
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}

/**
 * Titelleiste (Epic #192): Platz für die Ampeln, Seitenleisten-Knopf, ‹ ›,
 * Wortmarke in der Mitte, rechts die Ansicht (#203). Die ganze Leiste zieht
 * das Fenster (`titlebar-drag`), jeder Knopf ist davon ausgenommen.
 */
export default function TitleBar({
  variant = 'full',
  sidebarOpen = true,
  onToggleSidebar
}: TitleBarProps): React.JSX.Element {
  return (
    <div
      className="titlebar-drag relative flex h-11 shrink-0 select-none items-center gap-1.5 border-b border-border bg-surface-0 px-3"
      role="banner"
      aria-label="TheraScript"
    >
      {/* Ampeln des Fensters (hiddenInset, trafficLightPosition in main/index.ts) */}
      <span className="w-16 shrink-0" aria-hidden />
      {variant === 'full' && (
        <NavigationButtons sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />
      )}
      <span
        className="pointer-events-none absolute inset-x-0 text-center text-sm font-semibold tracking-tight text-text-primary"
        aria-hidden
      >
        TheraScript
      </span>
      {variant === 'full' && (
        <div className="relative ml-auto flex items-center gap-2">
          {/* Eingeklappt: der Update-Hinweis aus dem Fuss der Seitenleiste wandert hierher */}
          {!sidebarOpen && <CollapsedUpdateChip />}
          <ViewModeToggle />
        </div>
      )}
    </div>
  )
}

function NavigationButtons({
  sidebarOpen,
  onToggleSidebar
}: Pick<TitleBarProps, 'sidebarOpen' | 'onToggleSidebar'>): React.JSX.Element {
  const { canBack, canForward, back, forward } = useNavigation()
  const { reconcilePending } = useShellHints()
  // Festes Label plus aria-pressed: der Zustand steckt im «gedrückt», nicht im Namen.
  // Eingeklappt trägt der Knopf den Hinweispunkt aus dem Fuss der Seitenleiste.
  const showDot = !sidebarOpen && reconcilePending

  return (
    <div className="relative z-10 flex items-center gap-1.5">
      <TitleBarButton
        icon={PanelLeft}
        label={showDot ? `Seitenleiste — ${RECONCILE_HINT}` : 'Seitenleiste'}
        tooltip="Seitenleiste ein-/ausblenden"
        shortcut="⌃⌘S"
        pressed={sidebarOpen}
        dot={showDot}
        onClick={() => onToggleSidebar?.()}
      />
      <TitleBarButton
        icon={ChevronLeft}
        label="Zurück"
        shortcut="⌘["
        disabled={!canBack}
        onClick={() => back()}
      />
      <TitleBarButton
        icon={ChevronRight}
        label="Vorwärts"
        shortcut="⌘]"
        disabled={!canForward}
        onClick={forward}
      />
    </div>
  )
}

function CollapsedUpdateChip(): React.JSX.Element | null {
  const { updateHint } = useShellHints()
  return updateHint ? <UpdateChip hint={updateHint} placement="titlebar" /> : null
}

interface TitleBarButtonProps {
  icon: LucideIcon
  label: string
  /** Tooltip, falls er vom Namen abweicht (ohne Kürzel). */
  tooltip?: string
  shortcut: string
  pressed?: boolean
  dot?: boolean
  disabled?: boolean
  onClick: () => void
}

function TitleBarButton({
  icon: Icon,
  label,
  tooltip,
  shortcut,
  pressed,
  dot,
  disabled,
  onClick
}: TitleBarButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={`${tooltip ?? label} (${shortcut})`}
      className={`titlebar-no-drag inline-flex h-[30px] w-[30px] items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40 ${
        pressed ? 'bg-surface-2' : ''
      }`}
    >
      <span className="relative inline-flex">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        {dot && <ReconcileDot labelled={false} />}
      </span>
    </button>
  )
}
