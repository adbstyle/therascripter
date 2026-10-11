import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioRecorder } from '../services/AudioRecorder'
import { createValueStore, type ValueStore } from '../utils/valueStore'

interface UseRecordingResult {
  isRecording: boolean
  // Pegel und Dauer liegen bewusst NICHT im React-State: sonst rendert die
  // ganze App mit jedem Wert neu (Issue #140) — beim Pegel ~60× pro Sekunde.
  // Nur die Anzeigen abonnieren sie (VUMeter, RecordingSessionCard, RecordingBar).
  /** Live-Pegel: RMS 0–1, ein Wert pro ~16-ms-Fenster des Worklets */
  level: ValueStore<number>
  /** Aufnahmedauer in Sekunden, sekündlich vom Main-Prozess */
  duration: ValueStore<number>
  error: string | null
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
}

export function useRecording(): UseRecordingResult {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<AudioRecorder | null>(null)
  const startingRef = useRef(false)
  const stoppingRef = useRef(false)
  // Lazy-Initializer: ein Store pro Hook-Instanz, nicht pro Render
  const [level] = useState(() => createValueStore(0))
  const [duration] = useState(() => createValueStore(0))

  const stopRecording = useCallback(async () => {
    if (stoppingRef.current) return
    stoppingRef.current = true

    try {
      if (recorderRef.current) {
        await recorderRef.current.stop()
        recorderRef.current = null
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler beim Stoppen der Aufnahme')
    } finally {
      setIsRecording(false)
      duration.set(0)
      level.set(0)
      stoppingRef.current = false
    }
  }, [duration, level])

  const startRecording = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return
    startingRef.current = true

    setError(null)
    // Ein verspätetes Dauer-Event der vorigen Aufnahme (nach dem Reset beim
    // Stopp) darf die neue Karte nicht mit der alten Zeit starten lassen.
    duration.set(0)

    const recorder = new AudioRecorder()
    recorderRef.current = recorder

    try {
      await recorder.start(level.set)
      setIsRecording(true)
    } catch (err) {
      recorderRef.current = null

      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError(
          'Mikrofonzugriff wurde verweigert. Bitte erlauben Sie den Zugriff in den Systemeinstellungen.'
        )
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setError('Kein Mikrofon gefunden. Bitte schliessen Sie ein Mikrofon an.')
      } else {
        setError(err instanceof Error ? err.message : 'Aufnahme konnte nicht gestartet werden')
      }
    } finally {
      startingRef.current = false
    }
  }, [duration, level])

  // Listen for duration updates from main process
  useEffect(() => {
    if (!isRecording) return

    const cleanup = window.api.recording.onDuration(({ seconds }) => {
      duration.set(seconds)
    })

    return cleanup
  }, [isRecording, duration])

  // Listen for recording errors from main process
  useEffect(() => {
    if (!isRecording) return

    const cleanup = window.api.recording.onError(({ message }) => {
      setError(message)
    })

    return cleanup
  }, [isRecording])

  // Listen for auto-stop from main process (authoritative 2h timer)
  useEffect(() => {
    if (!isRecording) return

    const cleanup = window.api.recording.onAutoStopped(() => {
      if (stoppingRef.current) return
      stoppingRef.current = true

      // Main process already stopped recording — clean up renderer-side resources
      if (recorderRef.current) {
        recorderRef.current.stop().catch(() => {})
        recorderRef.current = null
      }
      setIsRecording(false)
      duration.set(0)
      level.set(0)
      stoppingRef.current = false
    })

    return cleanup
  }, [isRecording, duration, level])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current) {
        recorderRef.current.stop().catch(() => {})
      }
    }
  }, [])

  return { isRecording, level, duration, error, startRecording, stopRecording }
}
