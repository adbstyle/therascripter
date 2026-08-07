import { useEffect, useState, useCallback } from 'react'
import type { AppUpdateStatus, CheckResult } from '../../../shared/types/ModelUpdate'

interface UseAppUpdateResult {
  status: AppUpdateStatus | null
  checking: boolean
  checkNow: () => Promise<void>
  openReleasePage: () => void
}

export function useAppUpdate(): UseAppUpdateResult {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    // Populate from cached value immediately (no network)
    window.api.appUpdate
      .getStatus()
      .then(setStatus)
      .catch(() => {})
    // Listen for push updates from main process
    const unsub = window.api.appUpdate.onStatus(setStatus)
    return unsub
  }, [])

  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      const result: CheckResult = await window.api.appUpdate.check()
      setStatus(result.appUpdate)
    } catch {
      // Preserve existing status — don't overwrite a known "update available" with nulls
    } finally {
      setChecking(false)
    }
  }, [])

  const openReleasePage = useCallback(() => {
    window.api.appUpdate.openReleasePage()
  }, [])

  return { status, checking, checkNow, openReleasePage }
}
