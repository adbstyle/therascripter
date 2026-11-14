import { useCallback, useMemo } from 'react'
import { useNavigation } from '../../navigation/navigation'
import { useScrollRestoration } from '../../navigation/useScrollRestoration'
import { useLiveQuery } from '../../hooks/useLiveQuery'
import { useStartOfToday } from '../../hooks/useStartOfToday'
import { useRecordingState } from '../../contexts/recording'
import { groupTimelineByMonth } from '../../utils/groupTimelineByMonth'
import { RecordingSessionCard } from '../RecordingSessionCard'
import { TimelineEntryCard } from './TimelineEntryCard'
import type { TimelineEntry } from '../../../../shared/types/Dossier'

interface DossierTimelineProps {
  dossierId: string
}

/**
 * Verlauf des Patientendossiers (#205 AK 6–17), linke Spalte der Dossier-Seite.
 *
 * Reihenfolge und Tagesgrenzen kommen fertig aus dem Main-Prozess
 * (`dossier:timeline`, `sortDay` in Lokalzeit); hier wird nur nach Monaten
 * gegliedert. Titel, Zusammenfassung und Zustand bleiben aktuell, weil der
 * Verlauf bei jedem `sessions:changed`/`dossiers:changed` nachlädt; den
 * Fortschritt innerhalb eines Schritts zeigen die Task-Events (AK 14). Wer
 * einen Eintrag öffnet und zurückkehrt, findet ihn über den Anker des
 * Verlaufseintrags wieder (AK 16).
 */
export function DossierTimeline({ dossierId }: DossierTimelineProps): React.JSX.Element {
  const { navigate } = useNavigation()
  const recording = useRecordingState()
  const today = useStartOfToday()
  const timeline = useLiveQuery<TimelineEntry[]>(
    () => window.api.dossiers.timeline(dossierId),
    [
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    []
  )
  const { refresh } = timeline

  useScrollRestoration(!timeline.loading)

  const months = useMemo(() => groupTimelineByMonth(timeline.data), [timeline.data])
  const retryDisabled = useMemo(
    () => timeline.data.some((e) => e.status === 'queued' || e.status === 'processing'),
    [timeline.data]
  )

  const openEntry = useCallback(
    (sessionId: string) => navigate({ kind: 'session', sessionId }, { anchorId: sessionId }),
    [navigate]
  )
  const retry = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await window.api.tasks.retry(sessionId)
      } catch (err) {
        console.error('Retry failed:', err)
      }
      void refresh()
    },
    [refresh]
  )

  const { isRecording, sessionId: recordingId, duration, level, stopRecording } = recording
  const live = useMemo(
    () => (isRecording ? { duration, level, onStop: stopRecording } : null),
    [isRecording, duration, level, stopRecording]
  )

  return (
    <section aria-label="Verlauf" className="flex min-w-0 flex-[999_1_560px] flex-col gap-2">
      {timeline.loading && timeline.data.length === 0 ? (
        <p className="text-sm text-text-tertiary">Verlauf wird geladen …</p>
      ) : timeline.error && timeline.data.length === 0 ? (
        <p role="alert" className="text-sm text-text-secondary">
          Der Verlauf konnte nicht geladen werden.
        </p>
      ) : timeline.data.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">
            Noch keine Sitzungen oder PDF-Dokumente
          </p>
          <p className="max-w-md text-sm text-text-secondary">
            Ordnen Sie bestehende Transkriptionen in der Liste «Transkriptionen» über «Dossier
            zuordnen» diesem Patientendossier zu.
          </p>
          <button
            type="button"
            onClick={() => navigate({ kind: 'sessions' })}
            className="text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Zu den Transkriptionen
          </button>
        </div>
      ) : (
        months.map((month) => (
          <div key={month.key} className="mb-4 flex flex-col gap-2">
            {/* Deckend und über den Karten (siehe SessionDashboard) */}
            <h2 className="sticky top-0 z-20 bg-surface-0 py-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              {month.label}
            </h2>
            {month.entries.map((entry) =>
              entry.status === 'recording' && live && recordingId === entry.id ? (
                <RecordingSessionCard
                  key={entry.id}
                  session={entry}
                  live={live}
                  data-session-id={entry.id}
                />
              ) : (
                <TimelineEntryCard
                  key={entry.id}
                  entry={entry}
                  dossierId={dossierId}
                  onOpen={openEntry}
                  onRetry={entry.status === 'error' ? retry : undefined}
                  retryDisabled={retryDisabled}
                  today={today}
                />
              )
            )}
          </div>
        ))
      )}
    </section>
  )
}
