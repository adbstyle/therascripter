import { formatTime } from '../../utils/formatTime'

interface RecordingBarProps {
  duration: number
  onOpenRecording: () => void
}

/**
 * Schmale Status-Leiste für die laufende Aufnahme. Erscheint nur in Views,
 * in denen die RecordingSessionCard nicht sichtbar ist (Einstellungen,
 * Review) — auf der Sessions-Liste übernimmt die Karte, damit dieselbe
 * Information nie doppelt angezeigt wird. Klick führt zur Sessions-Liste.
 */
export default function RecordingBar({
  duration,
  onOpenRecording
}: RecordingBarProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpenRecording}
      aria-label="Zur laufenden Aufnahme wechseln"
      className="titlebar-no-drag flex w-full items-center justify-between border-b border-error-border bg-error-bg px-6 py-1.5 transition-colors hover:bg-error-bg/70"
    >
      <span className="flex items-center gap-2.5">
        <span
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-recording"
          aria-hidden="true"
        />
        <span className="text-sm font-medium text-recording">Aufnahme läuft</span>
        <span className="font-mono text-sm text-text-primary">{formatTime(duration)}</span>
      </span>
      <span className="text-xs text-error-text-emphasis underline decoration-dotted">
        Zur Aufnahme
      </span>
    </button>
  )
}
