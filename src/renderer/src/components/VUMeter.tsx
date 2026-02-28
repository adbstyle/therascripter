import { useRef } from 'react'

interface VUMeterProps {
  level: number // 0.0 to 1.0
}

const BAR_COUNT = 16

export function VUMeter({ level }: VUMeterProps): React.JSX.Element {
  const smoothedRef = useRef(0)

  // Gain + sqrt: amplify tiny RMS values (typical speech ≈ 0.001–0.02) to visible range
  const scaled = Math.min(1, Math.sqrt(Math.max(0, level) * 25))

  // Exponential smoothing: blend previous value with new level
  const smoothed = smoothedRef.current * 0.7 + scaled * 0.3
  smoothedRef.current = smoothed

  // Generate symmetric waveform-like bar heights centered on the middle
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    // Distance from center (0 = center, 1 = edge)
    const center = (BAR_COUNT - 1) / 2
    const distFromCenter = Math.abs(i - center) / center
    // Bars near center are taller, edges shorter — scaled by audio level
    const height = Math.max(0.05, smoothed * (1 - distFromCenter * 0.6))
    return height
  })

  return (
    <div
      className="flex items-end justify-center gap-1"
      style={{ height: '96px' }}
      role="meter"
      aria-label="Audiopegel"
      aria-valuenow={Math.round(smoothed * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {bars.map((height, i) => (
        <div
          key={i}
          className="w-2 rounded-sm transition-all duration-75"
          style={{
            height: `${Math.max(4, height * 96)}px`,
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
