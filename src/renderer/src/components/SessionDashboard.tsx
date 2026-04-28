import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Session, SessionStatus } from '../../../shared/types'
import { useSessions } from '../hooks/useSessions'
import { groupSessionsByTime, GROUP_ORDER } from '../utils/groupSessionsByTime'
import { SessionCard } from './SessionCard'
import { ConfirmDialog } from './ConfirmDialog'

const PROCESSING_STATUSES: SessionStatus[] = [
  'transcribing',
  'diarizing',
  'extracting',
  'anonymizing'
]

interface SessionDashboardProps {
  refreshTrigger?: number
  isImporting?: boolean
  onImportingChange?: (importing: boolean) => void
  onOpenReview?: (sessionId: string) => void
  scrollToSessionId?: string | null
  onScrollComplete?: () => void
}

export default function SessionDashboard({
  refreshTrigger,
  isImporting,
  onImportingChange,
  onOpenReview,
  scrollToSessionId,
  onScrollComplete
}: SessionDashboardProps): React.JSX.Element {
  const { sessions, loading, error, refresh, deleteSession } = useSessions()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Scroll to a specific session card after returning from review
  useLayoutEffect(() => {
    if (!scrollToSessionId || loading || sessions.length === 0) return
    const card = scrollContainerRef.current?.querySelector<HTMLElement>(
      `[data-session-id="${scrollToSessionId}"]`
    )
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'instant' })
      card.classList.add('session-highlight')
      card.addEventListener('animationend', () => card.classList.remove('session-highlight'), {
        once: true
      })
      onScrollComplete?.()
    }
  }, [scrollToSessionId, loading, sessions.length, onScrollComplete])

  // Derive processing state from sessions list (avoids race with brief isProcessing=false between tasks)
  const isAnyProcessing = useMemo(
    () => sessions.some((s) => PROCESSING_STATUSES.includes(s.status)),
    [sessions]
  )

  // Refresh sessions when parent triggers (e.g. after PDF import from header button)
  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      refresh()
    }
  }, [refreshTrigger, refresh])

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

      onImportingChange?.(true)
      try {
        await window.api.import.pdf(pdfPaths)
        refresh()
      } finally {
        onImportingChange?.(false)
      }
    },
    [refresh, isImporting, onImportingChange]
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

  const grouped = groupSessionsByTime(sessions)

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
        ref={scrollContainerRef}
        className={`relative flex-1 overflow-y-auto px-6 py-4 transition-colors ${isDragOver ? 'bg-primary-light' : ''}`}
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
              <h3 className="sticky -top-4 z-10 bg-surface-0 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                {group}
              </h3>
              <div className="flex flex-col gap-2">
                {groupSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    data-session-id={session.id}
                    onDelete={() => setDeleteTarget(session)}
                    onRetry={
                      session.status === 'error'
                        ? () => handleRetry(session.id)
                        : undefined
                    }
                    retryDisabled={isAnyProcessing}
                    onClick={
                      session.status === 'review' ? () => onOpenReview?.(session.id) : undefined
                    }
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Transkription löschen"
          message={`„${deleteTarget.title}“ und alle zugehörigen Daten unwiderruflich löschen?`}
          details={['Audiodatei', 'Originaltext', 'Anonymisierter Text', 'Platzhalter-Mapping']}
          confirmLabel="Löschen"
          destructive
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

    </>
  )
}
