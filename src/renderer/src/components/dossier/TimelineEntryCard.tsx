import { memo } from 'react'
import { FileText, Mic } from 'lucide-react'
import type { TimelineEntry } from '../../../../shared/types/Dossier'
import { useViewMode } from '../../viewMode/useViewMode'
import { sessionSummaryIn, sessionTitleIn } from '../../viewMode/sessionText'
import { startOfDay } from '../../hooks/useStartOfToday'
import { FULL_TIMESTAMP_FORMAT, formatCardTimestamp } from '../../utils/sessionDates'
import { SessionStatusBlock } from '../session/SessionStatusBlock'
import { DocumentDateButton } from '../session/DocumentDateButton'
import { DossierBadges } from './DossierBadges'

interface TimelineEntryCardProps {
  entry: TimelineEntry
  /** Dossier der Seite — erscheint nicht als «Auch in». */
  dossierId: string
  /** Öffnet einen fertig verarbeiteten Eintrag (#205 AK 15). */
  onOpen: (sessionId: string) => void
  onRetry?: (sessionId: string) => void
  retryDisabled?: boolean
  /** Beginn des aktuellen Tags (ms), siehe SessionCard. */
  today?: number
}

/**
 * Eintrag im Verlauf eines Patientendossiers (#205 AK 10–15): Art als Symbol
 * (Sitzung bzw. PDF-Dokument), Datum, Titel und Zusammenfassung in der
 * gewählten Ansicht, «Keine Zusammenfassung», Zustand samt Fortschritt und
 * Fehler, die anderen Dossiers als «Auch in: …». Öffnen lässt sich nur ein
 * fertig verarbeiteter Eintrag; die übrigen zeigen ihren Zustand.
 */
export const TimelineEntryCard = memo(function TimelineEntryCard({
  entry,
  dossierId,
  onOpen,
  onRetry,
  retryDisabled,
  today
}: TimelineEntryCardProps): React.JSX.Element {
  const viewMode = useViewMode()
  const isPdf = entry.type === 'pdf'
  const isReview = entry.status === 'review'
  const TypeIcon = isPdf ? FileText : Mic
  const typeLabel = isPdf ? 'PDF-Dokument' : 'Sitzung'

  const title = sessionTitleIn(entry, viewMode)
  const displayTitle = title.trim().length > 0 ? title : 'Unbenannte Transkription'
  const summary = sessionSummaryIn(entry, viewMode)?.trim() ?? ''

  return (
    <article
      className={`group relative rounded-lg border border-border bg-surface-0 px-4 py-3 transition-colors has-[button:focus-visible]:border-primary ${isReview ? 'hover:border-border-strong hover:shadow-sm' : ''}`}
      data-session-id={entry.id}
      aria-label={`${typeLabel}: ${displayTitle}`}
    >
      {isReview && (
        <button
          type="button"
          onClick={() => onOpen(entry.id)}
          aria-label={`${displayTitle} öffnen`}
          className="absolute inset-0 z-0 rounded-lg focus:outline-none"
        />
      )}

      <div className="pointer-events-none relative z-[1] flex items-start gap-3">
        <TypeIcon
          className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary"
          strokeWidth={1.75}
          role="img"
          aria-label={typeLabel}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <p
              className={`truncate text-sm font-medium ${isReview ? 'text-text-primary' : 'text-text-secondary'}`}
            >
              {displayTitle}
            </p>
            {isPdf ? (
              <DocumentDateButton
                session={entry}
                sessionLabel={displayTitle}
                className="shrink-0"
              />
            ) : (
              <time
                className="shrink-0 whitespace-nowrap text-xs text-text-secondary"
                dateTime={entry.createdAt}
                title={FULL_TIMESTAMP_FORMAT.format(new Date(entry.createdAt))}
              >
                {formatCardTimestamp(entry.createdAt, today ?? startOfDay())}
              </time>
            )}
          </div>
          {summary.length > 0 ? (
            <p className="line-clamp-3 text-xs leading-snug text-text-secondary">{summary}</p>
          ) : (
            isReview && <p className="text-xs italic text-text-secondary">Keine Zusammenfassung</p>
          )}
        </div>
      </div>

      <div className="pl-7">
        <SessionStatusBlock session={entry} onRetry={onRetry} retryDisabled={retryDisabled} />
        {/* Ohne z-index — die offene Auswahl soll über den folgenden Einträgen liegen */}
        <div className="pointer-events-none relative mt-1.5 empty:hidden">
          <DossierBadges
            sessionId={entry.id}
            sessionLabel={displayTitle}
            dossiers={entry.dossiers}
            variant="timeline"
            currentDossierId={dossierId}
          />
        </div>
      </div>
    </article>
  )
})
