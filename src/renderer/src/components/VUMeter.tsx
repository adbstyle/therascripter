import { useEffect, useRef } from 'react'
import type { ValueStore } from '../utils/valueStore'

interface VUMeterProps {
  /** Pegel-Quelle (RMS 0.0–1.0 aus dem AudioWorklet), siehe useRecording */
  level: ValueStore<number>
}

// Kompakte Ausprägung für die RecordingSessionCard — der einzige Aufrufer,
// seit die Vollbild-RecordingView (16 Balken / 96 px) entfernt wurde.
const BAR_COUNT = 6
const METER_HEIGHT = 18

// dB range for normalization: silence at -60 dB, speech clips rarely above -6 dBFS
const MIN_DB = -60
const MAX_DB = -6

// Kommt länger kein Pegel (Mikro abgezogen, AudioContext unterbrochen), fällt
// das Meter ab, statt auf dem letzten Sprachpegel einzufrieren — ein stehendes
// Meter täuschte eine laufende Aufnahme vor. Abgeklungen wird im Takt des
// Worklets, als kämen Nullwerte.
const STALE_MS = 100
const DECAY_STEP_MS = 16
const SILENT_BELOW = 0.005

const IDLE_HEIGHTS = barHeights(0)

/**
 * Zeichnet am React-Render vorbei: jeder Pegelwert aktualisiert die geglättete
 * Höhe, gemalt wird per rAF höchstens einmal pro Frame direkt über die Refs.
 * Über React-State würde jede Pegeländerung (~60 pro Sekunde) mindestens die
 * Karte neu rendern — vorher sogar die ganze App (Issue #140).
 */
export function VUMeter({ level }: VUMeterProps): React.JSX.Element {
  const meterRef = useRef<HTMLDivElement>(null)
  const barRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    let smoothed = 0
    let frame = 0
    let staleTimer: ReturnType<typeof setTimeout> | undefined

    const paint = (): void => {
      frame = 0
      meterRef.current?.setAttribute('aria-valuenow', String(Math.round(smoothed * 100)))
      barHeights(smoothed).forEach((height, i) => {
        const bar = barRefs.current[i]
        if (!bar) return
        bar.style.height = `${barPixels(height)}px`
        bar.style.backgroundColor = barColor(height)
      })
    }

    const update = (scaled: number): void => {
      // Light exponential smoothing (0.5/0.5) per worklet value (~16 ms) for
      // visual continuity without sluggishness. No CSS transition —
      // double-damping makes bars appear static.
      smoothed = smoothed * 0.5 + scaled * 0.5
      if (smoothed < SILENT_BELOW) smoothed = 0
      if (frame === 0) frame = requestAnimationFrame(paint)
    }

    const decay = (): void => {
      update(0)
      staleTimer = smoothed > 0 ? setTimeout(decay, DECAY_STEP_MS) : undefined
    }

    const unsubscribe = level.subscribe((rms) => {
      update(scaleLevel(rms))
      clearTimeout(staleTimer)
      staleTimer = setTimeout(decay, STALE_MS)
    })

    return () => {
      unsubscribe()
      cancelAnimationFrame(frame)
      clearTimeout(staleTimer)
    }
  }, [level])

  return (
    <div
      ref={meterRef}
      className="flex items-end justify-center gap-1"
      style={{ height: `${METER_HEIGHT}px` }}
      role="meter"
      aria-label="Audiopegel"
      aria-valuenow={0}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {IDLE_HEIGHTS.map((height, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el
          }}
          className="w-1 rounded-sm"
          style={{ height: `${barPixels(height)}px`, backgroundColor: barColor(height) }}
        />
      ))}
    </div>
  )
}

// Convert RMS to dB, then normalize to 0–1 within the expected speech range.
// This is perceptually correct and stable across different microphones,
// unlike arbitrary sqrt(level * N) scaling.
function scaleLevel(level: number): number {
  const db = 20 * Math.log10(Math.max(level, 1e-10))
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))
}

// Symmetric waveform-like bar heights: bars near the center are taller,
// edges shorter — scaled by the smoothed audio level.
function barHeights(smoothed: number): number[] {
  const center = (BAR_COUNT - 1) / 2
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const distFromCenter = Math.abs(i - center) / center
    return Math.max(0.03, smoothed * (1 - distFromCenter * 0.6))
  })
}

function barPixels(height: number): number {
  return Math.max(3, height * METER_HEIGHT)
}

function barColor(height: number): string {
  if (height > 0.8) return '#dc2626' // red (clipping)
  if (height > 0.5) return '#ea580c' // orange (loud)
  return '#16a34a' // green (normal)
}
