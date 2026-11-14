import { useCallback, useMemo, useState } from 'react'
import type { Session, SessionStatus } from '../../../shared/types'
import { useSessions } from '../hooks/useSessions'
import { useStartOfToday } from '../hooks/useStartOfToday'
import { groupSessionsByTime, GROUP_ORDER } from '../utils/groupSessionsByTime'
import { SessionCard } from './SessionCard'
import { RecordingSessionCard, type LiveRecording } from './RecordingSessionCard'
import { DeleteSessionDialog } from './DeleteSessionDialog'
import { useViewMode } from '../viewMode/useViewMode'
import { sessionTitleIn } from '../viewMode/sessionText'
import { useScrollRestoration } from '../navigation/useScrollRestoration'
import { useWorkspaceActions } from '../contexts/workspaceActions'

const PROCESSING_STATUSES: SessionStatus[] = ['queued', 'processing']

interface SessionDashboardProps {
  onOpenReview?: (sessionId: string) => void
  /** Laufende Aufnahme — die Karte mit Status 'recording' wird zur Live-Steuerung */
  liveRecording?: LiveRecording | null
}

/**
 * Sitzungsliste nach Zeitgruppen. Scrollt nicht selbst: der einzige
 * Scroll-Container ist `PageScroll` der Shell, der die Position pro
 * Verlaufseintrag kennt. Nach dem Schliessen einer Sitzung stellt
 * useScrollRestoration die Stelle wieder her und hebt die Karte hervor.
 */
export default function SessionDashboard({
  onOpenReview,
  liveRecording
}: SessionDashboardProps): React.JSX.Element {
  const { sessions, loading, error, refresh, deleteSession } = useSessions()
  const { importPdfs, isImporting } = useWorkspaceActions()
  // Rendert um Mitternacht neu: Zeitgruppen und memoisierte Karten ("Gestern")
  const today = useStartOfToday()
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const viewMode = useViewMode()
  const [isDragOver, setIsDragOver] = useState(false)

  useScrollRestoration(!loading)

  // Derive processing state from sessions list (avoids race with brief isProcessing=false between tasks)
  const isAnyProcessing = useMemo(
    () => sessions.some((s) => PROCESSING_STATUSES.includes(s.status)),
    [sessions]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)

      if (isImporting) return

      const files = Array.from(e.dataTransfer.files)
      const pdfPaths = files
        .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
        .map((f) => window.api.import.getPathForFile(f))
        .filter((p) => p.length > 0)

      if (pdfPaths.length === 0) return

      // Die Liste lädt über sessions:changed selbst nach
      await importPdfs(pdfPaths)
    },
    [importPdfs, isImporting]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  // Gleiches "Heute" wie die Karten, sonst widersprechen sich Gruppe und
  // Zeitstempel bis zur nächsten Tagesprüfung (≤ 60 s nach Mitternacht)
  const grouped = groupSessionsByTime(sessions, new Date(today))

  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    await deleteSession(deleteTarget.id)
    setDeleteTarget(null)
  }

  const handleRetry = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await window.api.tasks.retry(sessionId)
        refresh()
      } catch (err) {
        console.error('Retry failed:', err)
        refresh()
      }
    },
    [refresh]
  )

  if (loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className="text-sm text-text-tertiary">Laden...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className="text-sm text-red-500">{error}</p>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div
        className={`flex flex-1 items-center justify-center transition-colors ${isDragOver ? 'bg-primary-light' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="text-center">
          {isDragOver ? (
            <>
              <p className="mb-1 text-lg font-medium text-primary">PDF hier ablegen</p>
              <p className="text-sm text-text-tertiary">
                Lassen Sie die Datei los, um sie zu importieren.
              </p>
            </>
          ) : (
            <>
              <p className="mb-1 text-lg font-medium text-text-secondary">Keine Transkriptionen</p>
              <p className="text-sm text-text-tertiary">
                Starten Sie eine Aufnahme oder importieren Sie ein PDF-Dokument.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div
        className={`relative flex-1 rounded-lg transition-colors ${isDragOver ? 'bg-primary-light' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary-light/80">
            <p className="text-lg font-medium text-primary">PDF hier ablegen</p>
          </div>
        )}

        {GROUP_ORDER.map((group) => {
          const groupSessions = grouped.get(group)
          if (!groupSessions || groupSessions.length === 0) return null

          return (
            <div key={group} className="mb-6">
              {/* Deckend: z-20 liegt über den z-10-Elementen der Karten (Löschen-Knopf, Klickfläche),
                  die sonst als Randstreifen durch die Überschrift scheinen. Die Karten sind
                  nur `relative`, ohne eigenen Stapelkontext — z-10 gilt dort global. */}
              <h3 className="sticky top-0 z-20 bg-surface-0 pb-2 pt-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                {group}
              </h3>
              <div className="flex flex-col gap-2">
                {groupSessions.map((session) =>
                  session.status === 'recording' && liveRecording ? (
                    <RecordingSessionCard
                      key={session.id}
                      session={session}
                      live={liveRecording}
                      data-session-id={session.id}
                    />
                  ) : (
                    <SessionCard
                      key={session.id}
                      session={session}
                      data-session-id={session.id}
                      onDelete={setDeleteTarget}
                      onRetry={session.status === 'error' ? handleRetry : undefined}
                      retryDisabled={isAnyProcessing}
                      today={today}
                      onClick={session.status === 'review' ? onOpenReview : undefined}
                    />
                  )
                )}
              </div>
            </div>
          )
        })}
      </div>

      {deleteTarget && (
        <DeleteSessionDialog
          session={deleteTarget}
          displayTitle={sessionTitleIn(deleteTarget, viewMode)}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  )
}
