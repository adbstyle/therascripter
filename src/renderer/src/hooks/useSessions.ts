import { useCallback } from 'react'
import type { Session } from '../../../shared/types'
import type { SessionListItem } from '../../../shared/types/Dossier'
import { useLiveQuery, type LiveQueryEvent } from './useLiveQuery'

interface UseSessionsResult {
  sessions: SessionListItem[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  deleteSession: (sessionId: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<Session | null>
}

const fetchSessions = (): Promise<SessionListItem[]> => window.api.sessions.list()

// Der Main-Prozess meldet jede Änderung an einer Sitzung (angelegt, Status,
// Titel, Zusammenfassung, gelöscht) gebündelt über `sessions:changed`
// (Epic #192). Der Fortschritt innerhalb eines Schritts kommt weiterhin über
// die Task-Events (useTaskProgress), die Liste muss dafür nicht neu laden.
// `dossiers:changed`: die Plaketten zeigen Dossier-Namen (#205 AK 5).
const SESSION_EVENTS: LiveQueryEvent[] = [
  (callback) => window.api.sessions.onChanged(callback),
  (callback) => window.api.dossiers.onChanged(callback)
]

export function useSessions(): UseSessionsResult {
  const query = useLiveQuery(fetchSessions, SESSION_EVENTS, [] as SessionListItem[])
  const { setData } = query

  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const result = await window.api.sessions.delete(sessionId)
      if (result) {
        setData((prev) => prev.filter((s) => s.id !== sessionId))
      }
      return result
    },
    [setData]
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<Session | null> => {
      const updated = await window.api.sessions.rename(sessionId, title)
      if (updated) {
        setData((prev) =>
          prev.map((s) => (s.id === updated.id ? { ...updated, dossiers: s.dossiers } : s))
        )
      }
      return updated
    },
    [setData]
  )

  const error =
    query.error == null
      ? null
      : query.error instanceof Error
        ? query.error.message
        : 'Transkriptionen konnten nicht geladen werden'

  return {
    sessions: query.data,
    loading: query.loading,
    error,
    refresh: query.refresh,
    deleteSession,
    renameSession
  }
}
