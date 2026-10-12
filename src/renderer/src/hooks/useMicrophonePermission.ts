import { useCallback, useEffect, useState } from 'react'
import type { MicrophoneStatus } from '../../../shared/types/Microphone'

/**
 * - `lost`: Die Berechtigung war schon einmal erteilt und fehlt jetzt (z. B.
 *   nach einem Update) — Hinweis direkt nach dem Start (Issue #161, AK 3).
 * - `denied`: Ein Aufnahmestart ist an der fehlenden Berechtigung gescheitert
 *   — Hinweis mit dem Weg über die Systemeinstellungen (AK 4/5).
 */
export type MicrophoneHint = 'lost' | 'denied' | null

export interface MicrophonePermission {
  hint: MicrophoneHint
  allow: () => Promise<void>
  dismiss: () => void
  openSettings: () => void
  /**
   * Status aus einem Aufnahmestart übernehmen: Eine Ablehnung zeigt den Weg
   * über die Systemeinstellungen, eine erteilte Berechtigung räumt jeden
   * Hinweis — auch wenn die Aufnahme danach aus anderem Grund scheitert.
   */
  reportStatus: (status: MicrophoneStatus) => void
}

export function useMicrophonePermission(): MicrophonePermission {
  const [hint, setHint] = useState<MicrophoneHint>(null)

  const refresh = useCallback(async () => {
    const { status, previouslyGranted } = await window.api.microphone.getState()
    setHint((current) => {
      if (status === 'granted') return null
      // Den Aufnahme-Hinweis nicht beim Zurückkehren ins Fenster verlieren —
      // erst eine erteilte Berechtigung oder das Wegklicken räumt ihn.
      if (current === 'denied') return current
      return status === 'not-determined' && previouslyGranted ? 'lost' : null
    })
  }, [])

  // Prüfung beim Start, bei jedem Sichtbarwerden und bei jedem Fokus des
  // Fensters: Ein nach einem Update-Neustart verstecktes Fenster zeigt den
  // Hinweis, sobald es aufgeht, und eine in den Systemeinstellungen erteilte
  // Berechtigung räumt ihn beim Zurückkehren weg. `focus` deckt den Wechsel
  // aus den Systemeinstellungen ab, wenn das Fenster nie ganz verdeckt war
  // (dann feuert kein visibilitychange). Blockiert den ersten Paint nicht (NFR 1).
  useEffect(() => {
    void refresh()
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const onFocus = (): void => void refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const allow = useCallback(async () => {
    await window.api.microphone.ensureAccess()
    // Auch nach einer Ablehnung ausblenden: Erinnert wird dann erst beim
    // nächsten Aufnahmestart (AK 4).
    setHint(null)
  }, [])

  const dismiss = useCallback(() => {
    if (hint === 'lost') void window.api.microphone.dismissHint()
    setHint(null)
  }, [hint])

  const openSettings = useCallback(() => {
    void window.api.microphone.openSettings()
  }, [])

  const reportStatus = useCallback((status: MicrophoneStatus) => {
    if (status === 'granted') setHint(null)
    else if (status === 'denied' || status === 'restricted') setHint('denied')
  }, [])

  return { hint, allow, dismiss, openSettings, reportStatus }
}
