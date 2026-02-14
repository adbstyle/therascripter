import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'

beforeEach(() => {
  window.api = {
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      rename: vi.fn()
    }
  } as typeof window.api
})

describe('App', () => {
  it('renders Therascript title', () => {
    render(<App />)
    expect(screen.getByText('THERASCRIPT')).toBeInTheDocument()
  })

  it('shows empty state message when no sessions', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Keine Sitzungen')).toBeInTheDocument()
    })
  })
})
