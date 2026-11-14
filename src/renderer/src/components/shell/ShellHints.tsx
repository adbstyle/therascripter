import { useNavigation } from '../../navigation/navigation'
import { RECONCILE_HINT } from '../../hooks/useShellHints'

/** Chip «Update bereit/verfügbar» → Einstellungen › Updates (Seitenleiste und Titelleiste). */
export function UpdateChip({
  hint,
  placement
}: {
  hint: string
  placement: 'sidebar' | 'titlebar'
}): React.JSX.Element {
  const { navigate } = useNavigation()
  return (
    <button
      type="button"
      onClick={() => navigate({ kind: 'settings', subpage: 'updates' })}
      className={`flex items-center gap-2 rounded-md text-left text-xs font-medium text-primary transition-colors hover:bg-primary-light/30 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        placement === 'sidebar' ? 'px-2.5 py-1' : 'titlebar-no-drag h-[30px] px-2'
      }`}
    >
      <span aria-hidden className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" />
      <span>{hint}</span>
    </button>
  )
}

/** Punkt am Icon nach einer automatischen Modell-Anpassung (#84). */
export function ReconcileDot({ labelled = true }: { labelled?: boolean }): React.JSX.Element {
  return (
    <span
      aria-label={labelled ? RECONCILE_HINT : undefined}
      aria-hidden={labelled ? undefined : true}
      title={labelled ? RECONCILE_HINT : undefined}
      className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
    />
  )
}
