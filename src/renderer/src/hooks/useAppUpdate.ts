import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateInstallResult, AppUpdateState } from '../../../shared/types/AppUpdate'

/**
 * Braucht das App-Update die Nutzer:in? Bereit zur Installation, nur von Hand
 * installierbar oder verfügbar, aber nicht automatisch ladbar (aus, zu wenig
 * Platz, gescheitert). Ein laufender Hintergrund-Download bleibt unsichtbar
 * (PO-Entscheid #164). Eine Stelle für untere Leiste und Einstellungen.
 */
export function updateNeedsAttention(state: AppUpdateState | null): boolean {
  return state?.phase === 'ready' || state?.phase === 'unsupported' || state?.phase === 'available'
}

/** «Version 1.2.0» bzw. «Modell-Update» (#167: ein Update kann nur Modelle enthalten). */
export function updateTitle(state: Pick<AppUpdateState, 'version'>): string {
  return state.version ? `Version ${state.version}` : 'Modell-Update'
}

interface UseAppUpdateResult {
  state: AppUpdateState | null
  needsAttention: boolean
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
    needsAttention: updateNeedsAttention(state),
    checking,
    check,
    download,
    cancelDownload,
    install,
    setAutoUpdate,
    openInstallGuide
  }
}
