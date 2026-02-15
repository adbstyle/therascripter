import { useCallback, useEffect, useState } from 'react'
import type { Session } from '../../../shared/types'
import { useSessions } from '../hooks/useSessions'
import { groupSessionsByTime, GROUP_ORDER } from '../utils/groupSessionsByTime'
import { SessionCard } from './SessionCard'
import { ConfirmDialog } from './ConfirmDialog'
import { RenameDialog } from './RenameDialog'

interface SessionDashboardProps {
  refreshTrigger?: number
  isImporting?: boolean
  onImportingChange?: (importing: boolean) => void
  onOpenReview?: (sessionId: string) => void
}

export default function SessionDashboard({
  refreshTrigger,
  isImporting,
  onImportingChange,
  onOpenReview
}: SessionDashboardProps): React.JSX.Element {
  const { sessions, loading, error, refresh, deleteSession, renameSession } = useSessions()
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [renameTarget, setRenameTarget] = useState<Session | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

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

  const handleRename = async (title: string): Promise<void> => {
    if (!renameTarget) return
    await renameSession(renameTarget.id, title)
    setRenameTarget(null)
  }

  if (loading) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <p className="text-sm text-gray-400">Laden...</p>
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
        className={`flex flex-1 items-center justify-center transition-colors ${isDragOver ? 'bg-blue-50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="text-center">
          {isDragOver ? (
            <>
              <p className="mb-1 text-lg font-medium text-primary">PDF hier ablegen</p>
              <p className="text-sm text-gray-400">Lassen Sie die Datei los, um sie zu importieren.</p>
            </>
          ) : (
            <>
              <p className="mb-1 text-lg font-medium text-gray-600">Keine Sitzungen</p>
              <p className="text-sm text-gray-400">
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
        className={`relative flex-1 overflow-y-auto px-6 py-4 transition-colors ${isDragOver ? 'bg-blue-50' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-blue-50/80">
            <p className="text-lg font-medium text-primary">PDF hier ablegen</p>
          </div>
        )}

        {GROUP_ORDER.map((group) => {
          const groupSessions = grouped.get(group)
          if (!groupSessions || groupSessions.length === 0) return null

          return (
            <div key={group} className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                {group}
              </h3>
              <div className="flex flex-col gap-2">
                {groupSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    onRename={() => setRenameTarget(session)}
                    onDelete={() => setDeleteTarget(session)}
                    onClick={
                      session.status === 'review'
                        ? () => onOpenReview?.(session.id)
                        : undefined
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
          title="Sitzung löschen"
          message={`\u201e${deleteTarget.title}\u201c und alle zugehörigen Daten unwiderruflich löschen?`}
          details={['Audiodatei', 'Originaltext', 'Anonymisierter Text', 'Platzhalter-Mapping']}
          confirmLabel="Löschen"
          destructive
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {renameTarget && (
        <RenameDialog
          currentTitle={renameTarget.title}
          onConfirm={handleRename}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </>
  )
}
