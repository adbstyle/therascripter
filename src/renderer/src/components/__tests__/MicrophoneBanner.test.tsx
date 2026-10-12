import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MicrophoneBanner from '../MicrophoneBanner'

function renderBanner(variant: 'lost' | 'denied'): {
  onAllow: ReturnType<typeof vi.fn>
  onOpenSettings: ReturnType<typeof vi.fn>
  onDismiss: ReturnType<typeof vi.fn>
} {
  const handlers = { onAllow: vi.fn(), onOpenSettings: vi.fn(), onDismiss: vi.fn() }
  render(<MicrophoneBanner variant={variant} {...handlers} />)
  return handlers
}

describe('MicrophoneBanner', () => {
  it('bietet bei verlorener Berechtigung «Mikrofon erlauben» und «Später»', async () => {
    const { onAllow, onDismiss } = renderBanner('lost')
    expect(screen.getByText(/braucht Therascript die Mikrofon-Berechtigung/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Mikrofon erlauben' }))
    await userEvent.click(screen.getByRole('button', { name: 'Später' }))

    expect(onAllow).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('erklärt nach einer Ablehnung den Weg über die Systemeinstellungen', async () => {
    const { onOpenSettings, onDismiss, onAllow } = renderBanner('denied')
    expect(screen.getByText(/Datenschutz & Sicherheit → Mikrofon/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Systemeinstellungen öffnen' }))
    await userEvent.click(screen.getByRole('button', { name: 'Hinweis schliessen' }))

    expect(onOpenSettings).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onAllow).not.toHaveBeenCalled()
  })
})
