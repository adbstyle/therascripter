import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VUMeter } from '../VUMeter'
import { createValueStore } from '../../utils/valueStore'

// rAF manuell auslösen, um das Malen pro Frame prüfen zu können
let frames: FrameRequestCallback[] = []
const flushFrame = (): void => {
  const pending = frames
  frames = []
  pending.forEach((cb) => cb(0))
}

beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

const barHeightsPx = (container: HTMLElement): number[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[class*="w-1"]')).map((bar) =>
    parseFloat(bar.style.height)
  )

describe('VUMeter', () => {
  it('renders meter element with aria attributes', () => {
    const level = createValueStore(0)
    render(<VUMeter level={level} />)
    const meter = screen.getByRole('meter')
    expect(meter).toHaveAttribute('aria-label', 'Audiopegel')
    expect(meter).toHaveAttribute('aria-valuenow', '0')
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
  })

  it('renders 6 bars at minimum height before the first level', () => {
    const level = createValueStore(0)
    const { container } = render(<VUMeter level={level} />)
    const heights = barHeightsPx(container)
    expect(heights).toHaveLength(6)
    // max(0.03, 0) * 18 px < 3 px minimum
    heights.forEach((h) => expect(h).toBe(3))
  })

  it('reflects level in aria-valuenow and bar heights after the next frame', () => {
    const level = createValueStore(0)
    const { container } = render(<VUMeter level={level} />)
    const meter = screen.getByRole('meter')

    level.set(0.5)
    // Gemalt wird erst im Frame
    expect(meter).toHaveAttribute('aria-valuenow', '0')

    flushFrame()
    // dB: 20 * log10(0.5) ≈ -6.02 dBFS (top of the speech range)
    // scaled ≈ 0.9996, smoothed = 0 * 0.5 + 0.9996 * 0.5 ≈ 0.4998 → 50
    expect(meter).toHaveAttribute('aria-valuenow', '50')
    // Mittlere Balken: 0.4998 * (1 - 0.2 * 0.6) * 18 ≈ 7.9 px
    expect(barHeightsPx(container)[2]).toBeCloseTo(7.92, 1)
  })

  it('smooths 0.5/0.5 per level value and paints at most once per frame', () => {
    const level = createValueStore(0)
    render(<VUMeter level={level} />)

    level.set(0.5)
    level.set(0.5)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    flushFrame()
    // 0.4998 → 0.4998 * 0.5 + 0.9996 * 0.5 ≈ 0.7497 → 75
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '75')
  })

  it('unsubscribes on unmount', () => {
    const level = createValueStore(0)
    const { unmount } = render(<VUMeter level={level} />)

    unmount()
    level.set(0.5)
    expect(window.requestAnimationFrame).not.toHaveBeenCalled()
  })

  // Mikro abgezogen / AudioContext unterbrochen: kein Pegel mehr — das Meter
  // darf nicht auf dem letzten Sprachpegel stehen bleiben.
  it('fällt auf null ab, wenn keine Pegelwerte mehr kommen', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const level = createValueStore(0)
      const { container } = render(<VUMeter level={level} />)
      const meter = screen.getByRole('meter')

      level.set(0.5)
      flushFrame()
      expect(meter).toHaveAttribute('aria-valuenow', '50')

      // Innerhalb der Toleranz bleibt der Wert stehen
      vi.advanceTimersByTime(99)
      flushFrame()
      expect(meter).toHaveAttribute('aria-valuenow', '50')

      vi.advanceTimersByTime(1000)
      flushFrame()
      expect(meter).toHaveAttribute('aria-valuenow', '0')
      barHeightsPx(container).forEach((h) => expect(h).toBe(3))
    } finally {
      vi.useRealTimers()
    }
  })

  it('klingt nicht ab, solange Pegelwerte kommen', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const level = createValueStore(0)
      render(<VUMeter level={level} />)

      for (let i = 0; i < 20; i++) {
        level.set(0.5)
        vi.advanceTimersByTime(16)
      }
      flushFrame()
      // Konvergiert gegen ~100, ohne Einbruch durch das Abklingen
      expect(Number(screen.getByRole('meter').getAttribute('aria-valuenow'))).toBeGreaterThan(95)
    } finally {
      vi.useRealTimers()
    }
  })
})
