import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateInstallResult, AppUpdateState } from '../../../shared/types/AppUpdate'

interface UseAppUpdateResult {
  state: AppUpdateState | null
  checking: boolean
  check: () => Promise<void>
  download: () => void
  cancelDownload: () => void
  install: () => Promise<AppUpdateInstallResult | null>
  setAutoUpdate: (enabled: boolean) => void
  openInstallGuide: () => void
}

/** App-Update-Zustand aus dem Main-Prozess (Issues #164, #165). */
export function useAppUpdate(): UseAppUpdateResult {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.appUpdate
      .getState()
      .then(setState)
      .catch(() => {})
    return window.api.appUpdate.onState(setState)
  }, [])

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setState(await window.api.appUpdate.check())
    } catch {
      // Zustand bleibt — ein fehlgeschlagener Abruf ist kein Update-Fehler
    } finally {
      setChecking(false)
    }
  }, [])

  const download = useCallback(() => void window.api.appUpdate.download(), [])
  const cancelDownload = useCallback(() => void window.api.appUpdate.cancelDownload(), [])
  const install = useCallback(async () => {
    try {
      return await window.api.appUpdate.install()
    } catch {
      return null
    }
  }, [])
  const setAutoUpdate = useCallback(
    (enabled: boolean) => void window.api.appUpdate.setAutoUpdate(enabled),
    []
  )
  const openInstallGuide = useCallback(() => void window.api.appUpdate.openInstallGuide(), [])

  return {
    state,
    checking,
    check,
    download,
    cancelDownload,
    install,
    setAutoUpdate,
    openInstallGuide
  }
}
