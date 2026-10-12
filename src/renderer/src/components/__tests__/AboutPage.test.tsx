import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
  it('lists software and models with their license in Acknowledgments', () => {
    render(<AboutPage />)

    expect(screen.getByText('whisper.cpp')).toBeInTheDocument()
    expect(screen.getByText('Gemma 4 E2B')).toBeInTheDocument()
    expect(screen.getByText(/© Google LLC/)).toHaveTextContent('Apache License 2.0')
    expect(screen.queryByText('Modelle von Drittanbietern')).not.toBeInTheDocument()
  })

  it('renders a license text only after its entry is opened', () => {
    render(<AboutPage />)
    expect(screen.queryByText(/The ggml authors/)).not.toBeInTheDocument()

    const details = screen.getByText('llama.cpp').closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))

    expect(screen.getByText(/The ggml authors/)).toBeInTheDocument()
  })
})
