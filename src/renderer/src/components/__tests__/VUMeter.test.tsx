import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VUMeter } from '../VUMeter'

describe('VUMeter', () => {
  it('renders meter element with aria attributes', () => {
    render(<VUMeter level={0} />)
    const meter = screen.getByRole('meter')
    expect(meter).toBeInTheDocument()
    expect(meter).toHaveAttribute('aria-label', 'Audiopegel')
    expect(meter).toHaveAttribute('aria-valuemin', '0')
    expect(meter).toHaveAttribute('aria-valuemax', '100')
  })

  it('renders 6 bars', () => {
    const { container } = render(<VUMeter level={0.5} />)
    const bars = container.querySelectorAll('[class*="w-1"]')
    expect(bars).toHaveLength(6)
  })

  it('reflects level in aria-valuenow', () => {
    render(<VUMeter level={0.5} />)
    const meter = screen.getByRole('meter')
    // dB: db = 20 * log10(0.5) ≈ -6.02 dBFS (at the top of the speech range)
    // scaled = (-6.02 - (-60)) / (-6 - (-60)) ≈ 0.9996
    // Smoothing (0.5/0.5): smoothedRef starts at 0, smoothed = 0 * 0.5 + 0.9996 * 0.5 ≈ 0.4998
    // Math.round(0.4998 * 100) = 50
    expect(meter).toHaveAttribute('aria-valuenow', '50')
  })

  it('shows zero level with minimum bar heights', () => {
    const { container } = render(<VUMeter level={0} />)
    const bars = container.querySelectorAll('[class*="w-1"]')
    // With level=0, height = max(0.03, 0 * ...) = 0.03, rendered as max(3, 0.03 * 18) = 3px
    bars.forEach((bar) => {
      const height = parseFloat((bar as HTMLElement).style.height)
      expect(height).toBeLessThanOrEqual(4)
    })
  })
})
