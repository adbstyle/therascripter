import { MicOff, X } from 'lucide-react'
import type { MicrophoneHint } from '../hooks/useMicrophonePermission'

interface MicrophoneBannerProps {
  variant: Exclude<MicrophoneHint, null>
  onAllow: () => void
  onOpenSettings: () => void
  onDismiss: () => void
}

/**
 * Hinweis zur Mikrofon-Berechtigung (Issue #161). Der Aufrufer blendet ihn
 * während einer Aufnahme aus (NFR 2).
 */
export default function MicrophoneBanner({
  variant,
  onAllow,
  onOpenSettings,
  onDismiss
}: MicrophoneBannerProps): React.JSX.Element {
  const isLost = variant === 'lost'

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 border-b border-warning-border bg-warning-bg px-6 py-2.5"
    >
      <div className="flex items-center gap-2 text-sm text-warning-text">
        <MicOff className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        {isLost ? (
          <span>
            Die Mikrofon-Berechtigung fehlt, zum Beispiel nach einem Update. Ohne sie sind keine
            Aufnahmen möglich.
          </span>
        ) : (
          <span>
            Therascript hat keinen Zugriff auf das Mikrofon. Schalten Sie Therascript unter
            Systemeinstellungen → Datenschutz &amp; Sicherheit → Mikrofon ein.
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          className="titlebar-no-drag rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover"
          onClick={isLost ? onAllow : onOpenSettings}
        >
          {isLost ? 'Mikrofon erlauben' : 'Systemeinstellungen öffnen'}
        </button>
        {isLost ? (
          <button
            className="titlebar-no-drag rounded-md px-3 py-1.5 text-xs font-semibold text-warning-text-secondary transition-colors hover:text-warning-text"
            onClick={onDismiss}
          >
            Später
          </button>
        ) : (
          <button
            aria-label="Hinweis schliessen"
            className="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded-md text-warning-text-secondary transition-colors hover:text-warning-text"
            onClick={onDismiss}
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
