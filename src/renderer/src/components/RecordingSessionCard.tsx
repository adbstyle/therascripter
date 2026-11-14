import { useSyncExternalStore } from 'react'
import { Square } from 'lucide-react'
import type { Session } from '../../../shared/types'
import { AUTO_STOP_SECONDS } from '../../../shared/constants/recording'
import { VUMeter } from './VUMeter'
import type { ValueStore } from '../utils/valueStore'
import { formatTime } from '../utils/formatTime'
import { useViewMode } from '../viewMode/useViewMode'
import { sessionTitleIn } from '../viewMode/sessionText'
import { DossierBadges } from './dossier/DossierBadges'
import type { DossierRef } from '../../../shared/types/Dossier'

export interface LiveRecording {
  /** Pegel und Dauer als Store statt Wert — siehe useRecording (Issue #140) */
  duration: ValueStore<number>
  level: ValueStore<number>
  onStop: () => void
}

interface RecordingSessionCardProps {
  /** Mit `dossiers` zeigt die Karte die Plaketten — Zuordnen auch während der Aufnahme (#205 AK 3). */
  session: Session & { dossiers?: DossierRef[] }
  live: LiveRecording
  'data-session-id'?: string
}

/**
 * Live-Steuerung der laufenden Aufnahme, direkt in der Sessions-Liste.
 * Ersetzt die frühere Vollbild-RecordingView: Timer, Pegel, Stop und
 * Auto-Stop-Hinweis leben in der Karte; kein Löschen während der Aufnahme.
 */
export function RecordingSessionCard({
  session,
  live,
  'data-session-id': dataSessionId
}: RecordingSessionCardProps): React.JSX.Element {
  const duration = useSyncExternalStore(live.duration.subscribe, live.duration.get)
  const remaining = Math.max(0, AUTO_STOP_SECONDS - duration)
  const title = sessionTitleIn(session, useViewMode())
  const displayTitle = title.trim().length > 0 ? title : 'Unbenannte Transkription'

  return (
    <div
      className="rounded-lg border border-error-border bg-error-bg/30 px-4 py-3"
      data-session-id={dataSessionId}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium text-text-primary">{displayTitle}</p>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-recording"
            aria-hidden="true"
          />
          <span className="text-xs font-semibold text-recording">REC</span>
        </span>
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* Bewusst KEIN aria-live: der Wert ändert sich sekündlich — eine
              Live-Region würde Screenreader für die gesamte Sitzung fluten. */}
          <time
            className="font-mono text-xl font-semibold text-text-primary"
            aria-label={`Aufnahmedauer ${formatTime(duration)}`}
          >
            {formatTime(duration)}
          </time>
          <VUMeter level={live.level} />
        </div>

        <button
          onClick={live.onStop}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-recording-solid px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-recording-solid-hover"
          aria-label="Aufnahme stoppen"
        >
          <Square className="h-3 w-3 fill-current" strokeWidth={2} aria-hidden />
          Aufnahme stoppen
        </button>
      </div>

      <p className="mt-2 text-xs text-text-tertiary">Auto-Stop nach {formatTime(remaining)}</p>

      {session.dossiers !== undefined && (
        <div className="mt-2">
          <DossierBadges
            sessionId={session.id}
            sessionLabel={displayTitle}
            dossiers={session.dossiers}
            variant="list"
          />
        </div>
      )}
    </div>
  )
}
