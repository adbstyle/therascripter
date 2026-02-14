import { VUMeter } from './VUMeter'
import { ConsentBanner } from './ConsentBanner'

interface RecordingViewProps {
  duration: number
  level: number
  error: string | null
  onStop: () => void
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const AUTO_STOP_SECONDS = 7200 // 2 hours

export default function RecordingView({
  duration,
  level,
  error,
  onStop
}: RecordingViewProps): React.JSX.Element {
  const remaining = Math.max(0, AUTO_STOP_SECONDS - duration)

  return (
    <div className="flex flex-1 flex-col">
      <ConsentBanner />
      <div className="flex flex-1 items-center justify-center">
      <div className="flex flex-col items-center">
        {/* Recording indicator */}
        <div className="mb-6 flex items-center gap-2">
          <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-recording" />
          <span className="text-lg font-semibold text-recording">REC</span>
        </div>

        {/* Timer */}
        <time
          className="mb-8 font-mono text-5xl font-bold text-gray-900"
          aria-live="polite"
          aria-label={`Aufnahmedauer ${formatTime(duration)}`}
        >
          {formatTime(duration)}
        </time>

        {/* VU meter */}
        <div className="mb-8">
          <VUMeter level={level} />
        </div>

        {/* Stop button */}
        <button
          onClick={onStop}
          className="titlebar-no-drag rounded-lg bg-recording px-8 py-4 text-base font-semibold text-white transition-colors hover:bg-red-700"
          aria-label="Aufnahme stoppen"
        >
          &#9632; Aufnahme stoppen
        </button>

        {/* Auto-stop countdown */}
        <p className="mt-4 text-sm text-gray-500">Auto-Stop nach {formatTime(remaining)}</p>

        {/* Hint */}
        <p className="mt-6 max-w-sm text-center text-xs text-gray-400">
          Die App kann minimiert werden — die Aufnahme läuft im Hintergrund weiter.
        </p>

        {/* Error */}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
      </div>
    </div>
  )
}
