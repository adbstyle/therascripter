/** Werte von Electrons `systemPreferences.getMediaAccessStatus('microphone')`. */
export type MicrophoneStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface MicrophoneState {
  status: MicrophoneStatus
  /**
   * Hat diese Installation die Mikrofon-Berechtigung schon einmal gehabt?
   * Unterscheidet «nach einem Update verloren» (macOS fragt wieder, die App
   * weist beim Start darauf hin) von «nie erteilt» (erst beim Aufnahmestart
   * fragen). Issue #161.
   */
  previouslyGranted: boolean
}
