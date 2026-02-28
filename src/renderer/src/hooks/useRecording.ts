import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioRecorder } from '../services/AudioRecorder'

interface UseRecordingResult {
  isRecording: boolean
  duration: number
  level: number
  error: string | null
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
}

export function useRecording(): UseRecordingResult {
  const [isRecording, setIsRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<AudioRecorder | null>(null)
  const startingRef = useRef(false)
  const stoppingRef = useRef(false)
  const levelRef = useRef(0)
  const rafRef = useRef(0)

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
      levelRef.current = 0
      setIsRecording(false)
      setDuration(0)
      setLevel(0)
      stoppingRef.current = false
    }
  }, [])

  const startRecording = useCallback(async () => {
    if (startingRef.current || recorderRef.current) return
    startingRef.current = true

    setError(null)

    const recorder = new AudioRecorder()
    recorderRef.current = recorder

    try {
      await recorder.start((rmsLevel) => {
        levelRef.current = rmsLevel
      })
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
  }, [])

  // Listen for duration updates from main process
  useEffect(() => {
    if (!isRecording) return

    const cleanup = window.api.recording.onDuration(({ seconds }) => {
      setDuration(seconds)
    })

    return cleanup
  }, [isRecording])

  // Sync audio level to React state at display refresh rate (~60 fps)
  useEffect(() => {
    if (!isRecording) return

    let running = true
    const tick = (): void => {
      if (!running) return
      setLevel(levelRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [isRecording])

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
      setDuration(0)
      setLevel(0)
      stoppingRef.current = false
    })

    return cleanup
  }, [isRecording])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recorderRef.current) {
        recorderRef.current.stop().catch(() => {})
      }
    }
  }, [])

  return { isRecording, duration, level, error, startRecording, stopRecording }
}
