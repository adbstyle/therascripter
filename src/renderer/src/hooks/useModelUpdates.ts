import { useEffect, useState } from 'react'
import type { PendingModelUpdate } from '../../../shared/types/ModelUpdate'

export function useModelUpdates(): {
  availableUpdates: PendingModelUpdate[] | null
  clearUpdates: () => void
} {
  const [availableUpdates, setAvailableUpdates] = useState<PendingModelUpdate[] | null>(null)

  useEffect(() => {
    const unsub = window.api.modelUpdate.onAvailable((updates) => {
      if (updates.length > 0) {
        setAvailableUpdates(updates)
      }
    })
    return unsub
  }, [])

  return {
    availableUpdates,
    clearUpdates: () => setAvailableUpdates(null)
  }
}
