import { memo } from 'react'
import { FileText, Mic, Trash2 } from 'lucide-react'
import type { Session } from '../../../shared/types'
import type { DossierRef } from '../../../shared/types/Dossier'
import { useViewMode } from '../viewMode/useViewMode'
import { sessionSummaryIn, sessionTitleIn } from '../viewMode/sessionText'
import { startOfDay } from '../hooks/useStartOfToday'
import { FULL_TIMESTAMP_FORMAT, formatCardTimestamp } from '../utils/sessionDates'
import { SessionStatusBlock } from './session/SessionStatusBlock'
import { DossierBadges } from './dossier/DossierBadges'
import { DocumentDateButton } from './session/DocumentDateButton'

// Callbacks bekommen die Session bzw. ihre ID, damit SessionDashboard stabile
// Handler statt Closures pro Karte durchreichen kann — sonst griffe memo nie.
interface SessionCardProps {
  /**
   * Mit `dossiers` (Sitzungsliste, #205) zeigt die Karte die Plaketten der
   * Patientendossiers bzw. «Dossier zuordnen».
   */
  session: Session & { dossiers?: DossierRef[] }
  onDelete: (session: Session) => void
  onClick?: (sessionId: string) => void
  onRetry?: (sessionId: string) => void
  retryDisabled?: boolean
  /** Beginn des aktuellen Tags (ms) — wechselt um Mitternacht und rendert
   *  die memoisierte Karte dann neu ("Gestern"). Default: jetzt berechnet. */
  today?: number
  'data-session-id'?: string
}

export const SessionCard = memo(function SessionCard({
  session,
  onDelete,
  onClick,
  onRetry,
  retryDisabled,
  today,
  'data-session-id': dataSessionId
}: SessionCardProps): React.JSX.Element {
  const TypeIcon = session.type === 'audio' ? Mic : FileText
  const typeLabel = session.type === 'audio' ? 'Sprachaufnahme' : 'PDF-Dokument'

  const viewMode = useViewMode()
  const title = sessionTitleIn(session, viewMode)
  const displayTitle = title.trim().length > 0 ? title : 'Unbenannte Transkription'
  const summary = sessionSummaryIn(session, viewMode)?.trim()
  const hasSummary = summary != null && summary.length > 0
  const fullTimestamp = FULL_TIMESTAMP_FORMAT.format(new Date(session.createdAt))

  return (
    <div
      className={`group relative rounded-lg border border-border bg-surface-0 px-4 py-3 transition-colors hover:border-border-strong has-[button:focus-visible]:border-primary ${onClick ? 'hover:shadow-sm' : ''}`}
      data-session-id={dataSessionId}
    >
      {onClick && (
        <button
          type="button"
          onClick={() => onClick(session.id)}
          aria-label={`${displayTitle} öffnen`}
          className="absolute inset-0 z-0 rounded-lg focus:outline-none"
        />
      )}

      <div className="pointer-events-none relative z-[1] flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{displayTitle}</p>
          {hasSummary && (
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-text-secondary">
              {summary}
            </p>
          )}
        </div>

        <div className="relative shrink-0">
          <time
            className="block whitespace-nowrap text-xs text-text-tertiary transition-opacity group-hover:opacity-0"
            dateTime={session.createdAt}
            title={fullTimestamp}
          >
            {formatCardTimestamp(session.createdAt, today ?? startOfDay())}
          </time>
          {/* Kein Löschen für eine laufende Aufnahme — normalerweise rendert
              SessionDashboard dafür die RecordingSessionCard, aber im kurzen
              Fenster zwischen Session-Erstellung (main) und isRecording=true
              (renderer) kann diese Karte den 'recording'-Status zeigen. */}
          {session.status !== 'recording' && (
            <button
              className="pointer-events-auto absolute -right-1.5 -top-1.5 z-10 rounded p-1.5 text-text-tertiary opacity-0 transition-opacity hover:bg-error-bg hover:text-error-text group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onDelete(session)}
              aria-label="Transkription löschen"
              title="Löschen"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <SessionStatusBlock
        session={session}
        onRetry={onRetry}
        retryDisabled={retryDisabled}
        trailing={
          <TypeIcon
            className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
            strokeWidth={1.75}
            role="img"
            aria-label={typeLabel}
          />
        }
      />

      {(session.dossiers !== undefined || session.type === 'pdf') && (
        // Ohne z-index: sonst bildete die Zeile einen Stapelkontext und die
        // offene Auswahl läge unter den folgenden Karten und Gruppenköpfen
        <div className="pointer-events-none relative mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          {session.dossiers !== undefined ? (
            <DossierBadges
              sessionId={session.id}
              sessionLabel={displayTitle}
              dossiers={session.dossiers}
              variant="list"
            />
          ) : (
            <span />
          )}
          {session.type === 'pdf' && (
            <DocumentDateButton session={session} sessionLabel={displayTitle} />
          )}
        </div>
      )}
    </div>
  )
})
