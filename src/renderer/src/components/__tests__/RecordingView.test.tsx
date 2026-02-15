import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RecordingView from '../RecordingView'

beforeEach(() => {
  window.api = {
    settings: {
      get: vi.fn().mockResolvedValue(true),
      set: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as typeof window.api
})

describe('RecordingView', () => {
  const defaultProps = {
    duration: 0,
    level: 0,
    error: null,
    onStop: () => {}
  }

  it('renders recording indicator', () => {
    render(<RecordingView {...defaultProps} />)
    expect(screen.getByText('REC')).toBeInTheDocument()
  })

  it('renders formatted duration', () => {
    render(<RecordingView {...defaultProps} duration={3661} />)
    expect(screen.getByText('01:01:01')).toBeInTheDocument()
  })

  it('renders stop button', () => {
    render(<RecordingView {...defaultProps} />)
    expect(screen.getByLabelText('Aufnahme stoppen')).toBeInTheDocument()
  })

  it('calls onStop when stop button is clicked', async () => {
    const user = userEvent.setup()
    let called = false
    render(<RecordingView {...defaultProps} onStop={() => (called = true)} />)

    await user.click(screen.getByLabelText('Aufnahme stoppen'))
    expect(called).toBe(true)
  })

  it('shows auto-stop countdown', () => {
    render(<RecordingView {...defaultProps} duration={60} />)
    // 7200 - 60 = 7140 seconds = 01:59:00
    expect(screen.getByText('Auto-Stop nach 01:59:00')).toBeInTheDocument()
  })

  it('shows error message when error is provided', () => {
    render(<RecordingView {...defaultProps} error="Mic not found" />)
    expect(screen.getByText('Mic not found')).toBeInTheDocument()
  })

  it('does not show error when error is null', () => {
    render(<RecordingView {...defaultProps} />)
    expect(screen.queryByText('Mic not found')).not.toBeInTheDocument()
  })

  it('shows hint text', () => {
    render(<RecordingView {...defaultProps} />)
    expect(
      screen.getByText('Die App kann minimiert werden — die Aufnahme läuft im Hintergrund weiter.')
    ).toBeInTheDocument()
  })

  it('shows duration aria label', () => {
    render(<RecordingView {...defaultProps} duration={90} />)
    expect(screen.getByLabelText('Aufnahmedauer 00:01:30')).toBeInTheDocument()
  })
})
