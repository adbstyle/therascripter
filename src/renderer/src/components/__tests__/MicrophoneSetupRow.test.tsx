import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MicrophoneSetupRow from '../MicrophoneSetupRow'
import type { MicrophoneStatus } from '../../../../shared/types/Microphone'

const mic = {
  getState: vi.fn(),
  ensureAccess: vi.fn()
}

function withStatus(status: MicrophoneStatus): void {
  mic.getState.mockResolvedValue({ status, previouslyGranted: false })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api = { microphone: mic } as unknown as typeof window.api
})

describe('MicrophoneSetupRow', () => {
  it('fragt auf Klick nach der Berechtigung und zeigt das Ergebnis', async () => {
    withStatus('not-determined')
    mic.ensureAccess.mockResolvedValue('granted')
    render(<MicrophoneSetupRow />)

    await userEvent.click(await screen.findByRole('button', { name: 'Erlauben' }))

    expect(mic.ensureAccess).toHaveBeenCalledOnce()
    expect(await screen.findByText(/darf das Mikrofon für Aufnahmen verwenden/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erlauben' })).not.toBeInTheDocument()
  })

  it('erklärt nach einer Ablehnung, wo sie sich später erteilen lässt', async () => {
    withStatus('denied')
    render(<MicrophoneSetupRow />)

    expect(await screen.findByText(/Datenschutz & Sicherheit → Mikrofon/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Erlauben' })).not.toBeInTheDocument()
  })
})
