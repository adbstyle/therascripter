import { useCallback, useEffect, useState } from 'react'
import type { Session } from '../../../shared/types'

interface UseSessionsResult {
  sessions: Session[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  deleteSession: (sessionId: string) => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<Session | null>
}

export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      const result = await window.api.sessions.list()
      setSessions(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sitzungen konnten nicht geladen werden')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh session list when tasks complete or fail (session status changes)
  useEffect(() => {
    const cleanupCompleted = window.api.tasks.onCompleted(() => {
      refresh()
    })
    const cleanupError = window.api.tasks.onError(() => {
      refresh()
    })
    return () => {
      cleanupCompleted()
      cleanupError()
    }
  }, [refresh])

  const deleteSession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const result = await window.api.sessions.delete(sessionId)
      if (result) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      }
      return result
    },
    []
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string): Promise<Session | null> => {
      const updated = await window.api.sessions.rename(sessionId, title)
      if (updated) {
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      }
      return updated
    },
    []
  )

  return { sessions, loading, error, refresh, deleteSession, renameSession }
}
