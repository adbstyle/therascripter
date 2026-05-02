import { AlertTriangle, Check, CircleDot, Download } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Issue #84 / Story E — single source of truth for the disk-vs-active
 * status of a model card.
 *
 * - `active`       — currently the active model AND installed on disk.
 * - `installed`    — on disk, ready to be activated, but not currently active.
 * - `missing`      — not yet downloaded.
 * - `inconsistent` — defense-in-depth: settings believe the model is active
 *                    but its file is missing on disk. The bootstrap reconciler
 *                    (Story C) clears such states at startup; the badge
 *                    surfaces it for the rare in-session case (e.g. user
 *                    deleted the file in Finder while the app is running).
 */
export type ModelStatus = 'active' | 'installed' | 'missing' | 'inconsistent'

export function deriveModelStatus(entry: {
  isActive: boolean
  isInstalled: boolean
}): ModelStatus {
  if (entry.isActive && !entry.isInstalled) return 'inconsistent'
  if (entry.isActive) return 'active'
  if (entry.isInstalled) return 'installed'
  return 'missing'
}

interface BadgeStyle {
  Icon: LucideIcon
  /** Visible micro-text label. */
  label: string
  /** Tooltip / aria-label expansion of the label for screen readers. */
  description: string
  /** Tailwind classes for the pill wrapper (border + background + text colour). */
  pillClassName: string
  /** Tailwind classes for the icon — kept separate so the icon can pop in
   *  the green/orange semantic colour while the pill stays calm. */
  iconClassName: string
}

const STYLES: Record<ModelStatus, BadgeStyle> = {
  active: {
    Icon: CircleDot,
    label: 'Aktiv',
    description: 'Aktiv — wird für neue Verarbeitungen verwendet',
    pillClassName: 'border-border bg-surface-2 text-text-primary',
    iconClassName: 'text-success'
  },
  installed: {
    Icon: Check,
    label: 'Installiert',
    description: 'Installiert — kann aktiviert werden',
    pillClassName: 'border-border bg-surface-2 text-text-secondary',
    iconClassName: 'text-text-tertiary'
  },
  missing: {
    Icon: Download,
    label: 'Nicht installiert',
    description: 'Nicht installiert — noch nicht heruntergeladen',
    pillClassName: 'border-border bg-surface-1 text-text-tertiary',
    iconClassName: 'text-text-tertiary'
  },
  inconsistent: {
    Icon: AlertTriangle,
    // Locked spec text from Issue #84 UX update — pill carries the full
    // sentence (not truncated to a tooltip) so the self-heal promise is
    // visible without hover.
    label: 'Aktiv, aber fehlt — wird repariert',
    description:
      'Aktiv markiert, aber nicht auf Disk gefunden — wird beim nächsten Start automatisch repariert',
    pillClassName: 'border-warning-border bg-warning-bg text-warning-text',
    iconClassName: 'text-warning'
  }
}

interface Props {
  status: ModelStatus
}

export default function ModelStatusBadge({ status }: Props): React.JSX.Element {
  const style = STYLES[status]
  return (
    <span
      role="status"
      title={style.description}
      aria-label={style.description}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${style.pillClassName}`}
    >
      <style.Icon
        className={`h-3 w-3 ${style.iconClassName}`}
        strokeWidth={2}
        aria-hidden="true"
      />
      {style.label}
    </span>
  )
}
