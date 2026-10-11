import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VUMeter } from '../VUMeter'
import type { LevelCallback } from '../../services/AudioRecorder'

// Steuerbare Pegel-Quelle wie useRecording().subscribeLevel
function createLevelSource(): {
  subscribeLevel: (listener: LevelCallback) => () => void
  emit: (level: number) => void
  listenerCount: () => number
} {
  const listeners = new Set<LevelCallback>()
  return {
    subscribeLevel: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (level) => listeners.forEach((l) => l(level)),
    listenerCount: () => listeners.size
  }
}

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
    const source = createLevelSource()
    render(<VUMeter subscribeLevel={source.subscribeLevel} />)
    const meter = screen.getByRole('meter')
    expect(meter).toHaveAttribute('aria-label', 'Audiopegel')
    expect(meter).toHaveAttribute('aria-valuenow', '0')
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
  })

  it('renders 6 bars at minimum height before the first level', () => {
    const source = createLevelSource()
    const { container } = render(<VUMeter subscribeLevel={source.subscribeLevel} />)
    const heights = barHeightsPx(container)
    expect(heights).toHaveLength(6)
    // max(0.03, 0) * 18 px < 3 px minimum
    heights.forEach((h) => expect(h).toBe(3))
  })

  it('reflects level in aria-valuenow and bar heights after the next frame', () => {
    const source = createLevelSource()
    const { container } = render(<VUMeter subscribeLevel={source.subscribeLevel} />)
    const meter = screen.getByRole('meter')

    source.emit(0.5)
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
    const source = createLevelSource()
    render(<VUMeter subscribeLevel={source.subscribeLevel} />)

    source.emit(0.5)
    source.emit(0.5)
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1)

    flushFrame()
    // 0.4998 → 0.4998 * 0.5 + 0.9996 * 0.5 ≈ 0.7497 → 75
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '75')
  })

  it('unsubscribes on unmount', () => {
    const source = createLevelSource()
    const { unmount } = render(<VUMeter subscribeLevel={source.subscribeLevel} />)
    expect(source.listenerCount()).toBe(1)

    unmount()
    expect(source.listenerCount()).toBe(0)
  })
})
