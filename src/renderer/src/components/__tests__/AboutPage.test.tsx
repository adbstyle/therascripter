import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import AboutPage from '../AboutPage'

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      system: { aboutInfo: vi.fn().mockResolvedValue(null) },
      appUpdate: {
        getStatus: vi.fn().mockResolvedValue(null),
        onStatus: vi.fn().mockReturnValue(() => {})
      }
    }
  })
})

describe('AboutPage', () => {
  it('ships the Apache 2.0 license text for the redistributed Gemma 4 model', () => {
    render(<AboutPage />)

    expect(screen.getByText('Gemma 4 E2B')).toBeInTheDocument()
    expect(screen.getByText(/© Google LLC/)).toHaveTextContent('Apache License 2.0')
    expect(screen.getByText(/END OF TERMS AND CONDITIONS/)).toBeInTheDocument()
  })
})
