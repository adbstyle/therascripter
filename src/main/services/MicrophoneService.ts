import { systemPreferences } from 'electron'
import { getSettings } from './SettingsService'
import type { MicrophoneState, MicrophoneStatus } from '../../shared/types/Microphone'

/**
 * Mikrofon-Berechtigung (Issue #161). TCC ordnet die Aufnahme der Haupt-App
 * zu, die Berechtigung hängt an deren Designated Requirement (afterPack.js,
 * ADR-009). Verliert eine Installation sie trotzdem (Umstieg auf die neue
 * Signatur, frühere Builds mit cdhash-Requirement), fragt macOS wieder — die
 * App merkt sich deshalb, ob die Berechtigung schon einmal erteilt war, und
 * weist beim Start darauf hin statt erst beim nächsten Aufnahmestart.
 */
export interface MicrophoneDeps {
  getStatus(): MicrophoneStatus
  askForAccess(): Promise<boolean>
  getPreviouslyGranted(): boolean
  setPreviouslyGranted(value: boolean): void
}

export function getMicrophoneState(deps: MicrophoneDeps): MicrophoneState {
  const status = deps.getStatus()
  if (status === 'granted' && !deps.getPreviouslyGranted()) {
    deps.setPreviouslyGranted(true)
  }
  return { status, previouslyGranted: deps.getPreviouslyGranted() }
}

/**
 * Fragt macOS nur, solange noch nichts festgelegt ist — nach einer Ablehnung
 * zeigt macOS keine Rückfrage mehr, dann hilft nur der Weg über die
 * Systemeinstellungen. `unknown` (TCC nicht lesbar) zählt als «nicht
 * festgelegt»: sonst bliebe [Erlauben] wirkungslos stehen.
 */
export async function ensureMicrophoneAccess(deps: MicrophoneDeps): Promise<MicrophoneStatus> {
  const status = deps.getStatus()
  if (status === 'not-determined' || status === 'unknown') {
    await deps.askForAccess()
  }
  return getMicrophoneState(deps).status
}

/** «Später» beim Startup-Hinweis: danach erst beim Aufnahmestart wieder fragen. */
export function dismissMicrophoneHint(deps: MicrophoneDeps): void {
  deps.setPreviouslyGranted(false)
}

export function createElectronMicrophoneDeps(): MicrophoneDeps {
  return {
    getStatus: () => systemPreferences.getMediaAccessStatus('microphone') as MicrophoneStatus,
    askForAccess: () => systemPreferences.askForMediaAccess('microphone'),
    getPreviouslyGranted: () => getSettings().get('microphoneWasGranted') === true,
    setPreviouslyGranted: (value) => getSettings().set('microphoneWasGranted', value)
  }
}
