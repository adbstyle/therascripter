import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigation } from '../../navigation/navigation'
import { useScrollRestoration } from '../../navigation/useScrollRestoration'
import { useLiveQuery } from '../../hooks/useLiveQuery'
import { useStartOfToday } from '../../hooks/useStartOfToday'
import { useAnyInPipeline } from '../../hooks/useAnyInPipeline'
import { useRecordingState } from '../../contexts/recording'
import { useWorkspaceActions } from '../../contexts/workspaceActions'
import { groupTimelineByMonth } from '../../utils/groupTimelineByMonth'
import { shareById } from '../../utils/shareById'
import { RecordingSessionCard } from '../RecordingSessionCard'
import { TimelineEntryCard } from './TimelineEntryCard'
import type { TimelineEntry } from '../../../../shared/types/Dossier'

interface DossierTimelineProps {
  dossierId: string
  /** «Nachname, Vorname» — für den Hinweis, falls die Zuordnung scheitert (#206 AK 2). */
  dossierName?: string
}

/**
 * Verlauf des Patientendossiers (#205 AK 6–17), linke Spalte der Dossier-Seite.
 *
 * Reihenfolge und Tagesgrenzen kommen fertig aus dem Main-Prozess
 * (`dossier:timeline`, `sortDay` in Lokalzeit); hier wird nur nach Monaten
 * gegliedert. Titel, Zusammenfassung und Zustand bleiben aktuell, weil der
 * Verlauf bei jedem `sessions:changed`/`dossiers:changed` nachlädt; den
 * Fortschritt innerhalb eines Schritts zeigen die Task-Events (AK 14).
 * Unveränderte Einträge behalten beim Nachladen ihre Identität (`shareById`),
 * damit die memoisierten Karten nicht neu rendern — schon das Autosave eines
 * Namens in den Stammdaten löst `dossiers:changed` aus. Wer einen Eintrag
 * öffnet und zurückkehrt, findet ihn über den Anker wieder (AK 16).
 *
 * Solange die Auswahl der Dossiers eines Eintrags offen ist, zeigt der
 * Verlauf den Stand beim Öffnen: löst der USER die Zuordnung zum Dossier
 * dieser Seite, verschwindet der Eintrag erst nach dem Schliessen — sein
 * Häkchen bleibt bis dahin umkehrbar. Die Auswahl selbst zeigt den
 * bestätigten Stand jedes Häkchens.
 *
 * PDFs, die auf den Verlauf gezogen werden, importiert die App in dieses
 * Dossier (#206) — wie «PDF importieren» im Kopf der Seite.
 */
export function DossierTimeline({
  dossierId,
  dossierName
}: DossierTimelineProps): React.JSX.Element {
  const { navigate } = useNavigation()
  const recording = useRecordingState()
  const { importPdfs, isImporting } = useWorkspaceActions()
  const [isDragOver, setIsDragOver] = useState(false)
  const today = useStartOfToday()
  const retryDisabled = useAnyInPipeline()
  const sharedRef = useRef<TimelineEntry[]>([])
  const timeline = useLiveQuery<TimelineEntry[]>(
    async () => {
      const next = shareById(sharedRef.current, await window.api.dossiers.timeline(dossierId))
      sharedRef.current = next
      return next
    },
    [
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    []
  )
  const { refresh } = timeline

  // Einträge, deren Auswahl offen ist — solange bleibt der Verlauf eingefroren
  const [openSelections, setOpenSelections] = useState<ReadonlySet<string>>(() => new Set())
  const [frozen, setFrozen] = useState<TimelineEntry[] | null>(null)
  const onSelectionOpenChange = useCallback((entryId: string, open: boolean) => {
    setOpenSelections((prev) => {
      if (prev.has(entryId) === open) return prev
      const next = new Set(prev)
      if (open) next.add(entryId)
      else next.delete(entryId)
      return next
    })
  }, [])
  const anyOpen = openSelections.size > 0
  useEffect(() => {
    setFrozen(anyOpen ? sharedRef.current : null)
  }, [anyOpen])
  const entries = frozen ?? timeline.data

  useScrollRestoration(!timeline.loading)

  const months = useMemo(() => groupTimelineByMonth(entries), [entries])

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

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false)
  }, [])
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (isImporting) return
      const pdfPaths = Array.from(e.dataTransfer.files)
        .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
        .map((f) => window.api.import.getPathForFile(f))
        .filter((p) => p.length > 0)
      if (pdfPaths.length === 0) return
      // Der Verlauf lädt über sessions:changed/dossiers:changed selbst nach
      await importPdfs(pdfPaths, { dossierId, dossierName })
    },
    [importPdfs, isImporting, dossierId, dossierName]
  )

  const { isRecording, sessionId: recordingId, duration, level, stopRecording } = recording
  const live = useMemo(
    () => (isRecording ? { duration, level, onStop: stopRecording } : null),
    [isRecording, duration, level, stopRecording]
  )

  // Flach: Monatsköpfe sind Geschwister der Karten im selben Array. Wechselt
  // ein Eintrag den Monat (neues Dokumentdatum), bleibt seine Karte samt Fokus
  // erhalten — in verschachtelten Gruppen würde React sie neu aufbauen.
  const items: ReactNode[] = []
  months.forEach((month, monthIndex) => {
    items.push(
      <h2
        key={`month:${month.key}`}
        className={`sticky top-0 z-20 bg-surface-0 py-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary ${monthIndex > 0 ? 'mt-4' : ''}`}
      >
        {month.label}
      </h2>
    )
    for (const entry of month.entries) {
      items.push(
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
            onSelectionOpenChange={onSelectionOpenChange}
          />
        )
      )
    }
  })

  return (
    <section
      aria-label="Verlauf"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
      className={`relative flex min-w-0 flex-[999_1_560px] flex-col gap-2 rounded-lg transition-colors ${isDragOver ? 'bg-primary-light' : ''}`}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-primary bg-primary-light/80 text-center">
          <p className="text-lg font-medium text-primary">PDF hier ablegen</p>
          <p className="text-sm text-text-secondary">Es wird diesem Patientendossier zugeordnet.</p>
        </div>
      )}
      {timeline.loading && entries.length === 0 ? (
        <p className="text-sm text-text-tertiary">Verlauf wird geladen …</p>
      ) : timeline.error && entries.length === 0 ? (
        <p role="alert" className="text-sm text-text-secondary">
          Der Verlauf konnte nicht geladen werden.
        </p>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong px-6 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">
            Noch keine Sitzungen oder PDF-Dokumente
          </p>
          <p className="max-w-md text-sm text-text-secondary">
            Starten Sie oben eine Aufnahme oder importieren Sie ein PDF – oder ziehen Sie ein PDF
            hierher. Bestehende Transkriptionen ordnen Sie in der Liste «Transkriptionen» über
            «Dossier zuordnen» zu.
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
        items
      )}
    </section>
  )
}
