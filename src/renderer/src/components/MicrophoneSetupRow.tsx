import { useCallback, useEffect, useState } from 'react'
import { Check, Mic, MicOff } from 'lucide-react'
import type { MicrophoneStatus } from '../../../shared/types/Microphone'

/**
 * Mikrofon-Berechtigung in der Ersteinrichtung (Issue #161, AK 1). Optional:
 * Wer sie hier nicht erteilt, wird beim ersten Aufnahmestart gefragt.
 */
export default function MicrophoneSetupRow(): React.JSX.Element | null {
  const [status, setStatus] = useState<MicrophoneStatus | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    window.api.microphone.getState().then((state) => setStatus(state.status))
  }, [])

  const handleAllow = useCallback(async () => {
    setAsking(true)
    try {
      setStatus(await window.api.microphone.ensureAccess())
    } finally {
      setAsking(false)
    }
  }, [])

  if (status === null) return null

  const granted = status === 'granted'
  const refused = status === 'denied' || status === 'restricted'

  return (
    <div className="mt-6 flex items-start gap-3 rounded-lg border border-border p-4">
      {granted ? (
        <Check className="mt-0.5 h-5 w-5 shrink-0 text-success" strokeWidth={2.5} aria-hidden />
      ) : refused ? (
        <MicOff
          className="mt-0.5 h-5 w-5 shrink-0 text-text-tertiary"
          strokeWidth={1.75}
          aria-hidden
        />
      ) : (
        <Mic className="mt-0.5 h-5 w-5 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
      )}
      <div className="flex-1 text-sm">
        <p className="font-medium text-text-primary">Mikrofon</p>
        <p className="text-text-secondary">
          {granted
            ? 'Therascript darf das Mikrofon für Aufnahmen verwenden.'
            : refused
              ? 'Ohne Mikrofon-Berechtigung sind keine Aufnahmen möglich. Sie können sie später unter Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon erteilen.'
              : 'Für Aufnahmen braucht Therascript Zugriff auf das Mikrofon. macOS fragt Sie danach.'}
        </p>
      </div>
      {!granted && !refused && (
        <button
          className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-semibold text-text-secondary transition-colors hover:bg-surface-1 disabled:opacity-50"
          onClick={handleAllow}
          disabled={asking}
        >
          Erlauben
        </button>
      )}
    </div>
  )
}
