import { useRef } from 'react'

interface VUMeterProps {
  level: number // 0.0 to 1.0 (RMS from AudioWorklet)
}

// Kompakte Ausprägung für die RecordingSessionCard — der einzige Aufrufer,
// seit die Vollbild-RecordingView (16 Balken / 96 px) entfernt wurde.
const BAR_COUNT = 6
const METER_HEIGHT = 18

// dB range for normalization: silence at -60 dB, speech clips rarely above -6 dBFS
const MIN_DB = -60
const MAX_DB = -6

export function VUMeter({ level }: VUMeterProps): React.JSX.Element {
  const smoothedRef = useRef(0)

  // Convert RMS to dB, then normalize to 0–1 within the expected speech range.
  // This is perceptually correct and stable across different microphones,
  // unlike arbitrary sqrt(level * N) scaling.
  const db = 20 * Math.log10(Math.max(level, 1e-10))
  const scaled = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))

  // Light exponential smoothing (0.5/0.5) for visual continuity without sluggishness.
  // No CSS transition — double-damping makes bars appear static.
  const smoothed = smoothedRef.current * 0.5 + scaled * 0.5
  smoothedRef.current = smoothed

  // Generate symmetric waveform-like bar heights centered on the middle
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    // Distance from center (0 = center, 1 = edge)
    const center = (BAR_COUNT - 1) / 2
    const distFromCenter = Math.abs(i - center) / center
    // Bars near center are taller, edges shorter — scaled by audio level
    const height = Math.max(0.03, smoothed * (1 - distFromCenter * 0.6))
    return height
  })

  return (
    <div
      className="flex items-end justify-center gap-1"
      style={{ height: `${METER_HEIGHT}px` }}
      role="meter"
      aria-label="Audiopegel"
      aria-valuenow={Math.round(smoothed * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {bars.map((height, i) => (
        <div
          key={i}
          className="w-1 rounded-sm"
          style={{
            height: `${Math.max(3, height * METER_HEIGHT)}px`,
            backgroundColor: barColor(height)
          }}
        />
      ))}
    </div>
  )
}

function barColor(height: number): string {
  if (height > 0.8) return '#dc2626' // red (clipping)
  if (height > 0.5) return '#ea580c' // orange (loud)
  return '#16a34a' // green (normal)
}
