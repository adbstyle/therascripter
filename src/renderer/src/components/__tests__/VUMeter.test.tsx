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

  it('renders 16 bars', () => {
    const { container } = render(<VUMeter level={0.5} />)
    const bars = container.querySelectorAll('[class*="w-2"]')
    expect(bars).toHaveLength(16)
  })

  it('reflects level in aria-valuenow', () => {
    render(<VUMeter level={0.5} />)
    const meter = screen.getByRole('meter')
    // Gain+sqrt: scaled = min(1, sqrt(0.5 * 25)) = min(1, 3.54) = 1.0
    // Smoothing: smoothedRef starts at 0, smoothed = 0 * 0.7 + 1.0 * 0.3 = 0.3
    // Math.round(0.3 * 100) = 30
    expect(meter).toHaveAttribute('aria-valuenow', '30')
  })

  it('shows zero level with minimum bar heights', () => {
    const { container } = render(<VUMeter level={0} />)
    const bars = container.querySelectorAll('[class*="w-2"]')
    // With level=0, height = max(0.05, 0 * ...) = 0.05, rendered as max(4, 0.05 * 96) = 4.8px
    bars.forEach((bar) => {
      const height = parseFloat((bar as HTMLElement).style.height)
      expect(height).toBeLessThanOrEqual(5)
    })
  })
})
