import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useRecording } from '../hooks/useRecording'
import { useMicrophonePermission } from '../hooks/useMicrophonePermission'
import { useToast } from '../hooks/useToast'
import { RecordingContext, type RecordingState } from './recording'

/**
 * Hält die Aufnahme über alle Seiten hinweg (Aufnahme ist ein Status, kein
 * Modus): Seiten wechseln, die Aufnahme läuft weiter. Pegel und Dauer bleiben
 * ValueStores — der Kontextwert ändert sich nur bei Start, Stopp, Fehler und
 * Hinweisen, nie mit jedem Messwert (Issue #140).
 */
export function RecordingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const microphone = useMicrophonePermission()
  const { isRecording, sessionId, level, duration, error, startRecording, stopRecording } =
    useRecording({ onMicrophoneStatus: microphone.reportStatus })
  const toast = useToast()
  // Pro Aufnahme: wurde der Consent-Hinweis weggeklickt? Lebt hier, nicht im
  // Banner — die Seite mit dem Banner wird bei jedem Seitenwechsel neu gemountet.
  const [consentDismissed, setConsentDismissed] = useState(false)
  const dismissConsent = useCallback(() => setConsentDismissed(true), [])

  const wasRecording = useRef(isRecording)
  useEffect(() => {
    if (isRecording && !wasRecording.current) setConsentDismissed(false)
    wasRecording.current = isRecording
  }, [isRecording])

  // Aufnahmefehler als Toast: es gibt keine Vollbild-Aufnahmeansicht, die sie
  // zeigen könnte. Eine fehlende Mikrofon-Berechtigung zeigt der MicrophoneBanner.
  useEffect(() => {
    if (error) toast.error(error)
  }, [error, toast])

  const value = useMemo<RecordingState>(
    () => ({
      isRecording,
      sessionId,
      recordingDossierId: null,
      level,
      duration,
      startRecording,
      stopRecording,
      microphone,
      consentDismissed,
      dismissConsent
    }),
    [
      isRecording,
      sessionId,
      level,
      duration,
      startRecording,
      stopRecording,
      microphone,
      consentDismissed,
      dismissConsent
    ]
  )

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>
}
