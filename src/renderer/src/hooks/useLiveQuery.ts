import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

/** Meldet sich bei einem Push-Event an und liefert die Abmeldung. */
export type LiveQueryEvent = (callback: () => void) => () => void

export interface LiveQuery<T> {
  data: T
  loading: boolean
  error: unknown
  refresh: () => Promise<void>
  /** Lokale Korrektur (z. B. sofort entfernen), bis die nächste Abfrage kommt. */
  setData: Dispatch<SetStateAction<T>>
}

/**
 * Lädt Daten und lädt bei jedem der `events` nach (Epic #192). Es läuft
 * höchstens EINE Abfrage; kommen währenddessen weitere Events, folgt genau
 * eine nachgeschobene — ein Sturm von Events wird so zu höchstens zwei
 * Abfragen und überholt sich nie.
 *
 * `fetcher` und `events` werden beim Mount gelesen bzw. über eine Ref
 * aktuell gehalten; sie müssen nicht stabil sein.
 */
export function useLiveQuery<T>(
  fetcher: () => Promise<T>,
  events: LiveQueryEvent[],
  initial: T
): LiveQuery<T> {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const eventsRef = useRef(events)
  const inFlight = useRef<Promise<void> | null>(null)
  const queued = useRef(false)
  const mounted = useRef(false)

  const runOnce = useCallback(async () => {
    try {
      const result = await fetcherRef.current()
      if (!mounted.current) return
      setData(result)
      setError(null)
    } catch (err) {
      if (mounted.current) setError(err)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      queued.current = true
      return inFlight.current
    }
    const run = (async () => {
      do {
        queued.current = false
        await runOnce()
      } while (queued.current && mounted.current)
    })().finally(() => {
      inFlight.current = null
    })
    inFlight.current = run
    return run
  }, [runOnce])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const unsubscribe = eventsRef.current.map((subscribe) => subscribe(() => void refresh()))
    return () => {
      mounted.current = false
      for (const off of unsubscribe) off()
    }
  }, [refresh])

  return { data, loading, error, refresh, setData }
}
