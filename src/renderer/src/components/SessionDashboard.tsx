import { useState } from 'react'
import type { Session } from '../../../shared/types'
import { useSessions } from '../hooks/useSessions'
import { groupSessionsByTime, GROUP_ORDER } from '../utils/groupSessionsByTime'
import { SessionCard } from './SessionCard'
import { ConfirmDialog } from './ConfirmDialog'
import { RenameDialog } from './RenameDialog'

export default function SessionDashboard(): React.JSX.Element {
  const { sessions, loading, error, deleteSession, renameSession } = useSessions()
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [renameTarget, setRenameTarget] = useState<Session | null>(null)

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
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-gray-400">Laden...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-red-500">{error}</p>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="mb-1 text-lg font-medium text-gray-600">Keine Sitzungen</p>
          <p className="text-sm text-gray-400">
            Starten Sie eine Aufnahme oder importieren Sie ein PDF-Dokument.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-4">
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
