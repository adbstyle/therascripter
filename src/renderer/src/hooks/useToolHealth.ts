import { useCallback, useEffect, useState } from 'react'
import type { ToolHealthState } from '../../../shared/tool-blocked'

interface UseToolHealthResult {
  state: ToolHealthState | null
  checking: boolean
  recheck: () => Promise<void>
  openGuide: () => void
}

/** Zustand der eingebauten Werkzeuge aus dem Main-Prozess (Issue #168). */
export function useToolHealth(): UseToolHealthResult {
  const [state, setState] = useState<ToolHealthState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    // Ein Push während des Abholens ist neuer als dessen Antwort
    let pushed = false
    const unsub = window.api.toolHealth.onState((next) => {
      pushed = true
      setState(next)
    })
    window.api.toolHealth
      .getState()
      .then((initial) => {
        if (!pushed) setState(initial)
      })
      .catch(() => {})
    return unsub
  }, [])

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      setState(await window.api.toolHealth.recheck())
    } catch {
      // Zustand bleibt
    } finally {
      setChecking(false)
    }
  }, [])

  const openGuide = useCallback(() => void window.api.toolHealth.openGuide(), [])

  return { state, checking, recheck, openGuide }
}
