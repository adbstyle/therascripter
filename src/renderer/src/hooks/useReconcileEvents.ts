import { useCallback, useEffect, useState } from 'react'
import type { ReconcileEvent } from '../../../shared/types/ReconcileEvent'

// Cross-component synchronisation: the BottomNav dot and the Settings →
// Modelle banner both render reconcile events. When one component mutates
// the events (markSeen on settings mount, dismiss on "Verstanden"), the
// other needs to re-read. A window-level CustomEvent keeps the two views
// in sync without standing up a full IPC push channel for what is a
// renderer-only state-fanout problem.
const RECONCILE_CHANGED = 'therascript:reconcileEventsChanged'

interface UseReconcileEvents {
  events: ReconcileEvent[]
  pendingCount: number
  refresh: () => Promise<void>
  markSeen: () => Promise<void>
  dismiss: () => Promise<void>
}

export function useReconcileEvents(): UseReconcileEvents {
  const [events, setEvents] = useState<ReconcileEvent[]>([])

  const refresh = useCallback(async () => {
    const fresh = await window.api.modelReconcile.getEvents()
    setEvents(fresh)
  }, [])

  useEffect(() => {
    refresh()
    const handler = (): void => {
      refresh()
    }
    window.addEventListener(RECONCILE_CHANGED, handler)
    return () => {
      window.removeEventListener(RECONCILE_CHANGED, handler)
    }
  }, [refresh])

  const markSeen = useCallback(async () => {
    await window.api.modelReconcile.markSeen()
    window.dispatchEvent(new Event(RECONCILE_CHANGED))
  }, [])

  const dismiss = useCallback(async () => {
    await window.api.modelReconcile.dismiss()
    window.dispatchEvent(new Event(RECONCILE_CHANGED))
  }, [])

  const pendingCount = events.reduce((n, e) => (e.status === 'pending' ? n + 1 : n), 0)

  return { events, pendingCount, refresh, markSeen, dismiss }
}
