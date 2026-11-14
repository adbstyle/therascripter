import { createContext, useContext } from 'react'
import type { ValueStore } from '../utils/valueStore'
import type { MicrophonePermission } from '../hooks/useMicrophonePermission'
import type { RecordingStartOptions, RecordingStartResult } from '../../../shared/types/IpcApi'

export interface RecordingState {
  isRecording: boolean
  /** Sitzung der laufenden Aufnahme, sonst null. */
  sessionId: string | null
  /**
   * Patientendossier, aus dem heraus die laufende Aufnahme gestartet und dem
   * sie zugeordnet wurde (#206); null ohne Dossier oder bei gescheiterter Zuordnung.
   */
  recordingDossierId: string | null
  // Stores statt Werten: nur die Anzeigen abonnieren sie, nicht die App (#140)
  level: ValueStore<number>
  duration: ValueStore<number>
  startRecording: (options?: RecordingStartOptions) => Promise<RecordingStartResult | null>
  stopRecording: () => Promise<void>
  /** Mikrofon-Berechtigung samt Hinweis (Issue #161). */
  microphone: MicrophonePermission
  /** Consent-Hinweis für die laufende Aufnahme weggeklickt (gilt pro Aufnahme). */
  consentDismissed: boolean
  dismissConsent: () => void
}

export const RecordingContext = createContext<RecordingState | null>(null)

/** Laufende Aufnahme für die ganze Shell (Epic #192). */
export function useRecordingState(): RecordingState {
  const state = useContext(RecordingContext)
  if (!state) throw new Error('useRecordingState braucht einen RecordingProvider')
  return state
}
