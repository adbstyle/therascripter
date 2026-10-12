import { useEffect, useState } from 'react'
import type { PendingModelUpdate } from '../../../shared/types/ModelUpdate'

/**
 * Verfügbare Modell-Updates (Issue #144). Der Main-Prozess hält den Stand:
 * beim Mount abholen, danach Pushes übernehmen — auch eine leere Liste nach
 * «Verwerfen». So zeigen Banner und Einstellungen dasselbe, egal wann sie
 * mounten. null = keine Updates.
 */
export function useModelUpdates(): { availableUpdates: PendingModelUpdate[] | null } {
  const [availableUpdates, setAvailableUpdates] = useState<PendingModelUpdate[] | null>(null)

  useEffect(() => {
    const apply = (updates: PendingModelUpdate[]): void =>
      setAvailableUpdates(updates.length > 0 ? updates : null)
    // Ein Push während des Abholens ist neuer als dessen Antwort
    let pushed = false
    const unsub = window.api.modelUpdate.onAvailable((updates) => {
      pushed = true
      apply(updates)
    })
    window.api.modelUpdate
      .getAvailable()
      .then((updates) => {
        if (!pushed) apply(updates)
      })
      .catch(() => {})
    return unsub
  }, [])

  return { availableUpdates }
}
