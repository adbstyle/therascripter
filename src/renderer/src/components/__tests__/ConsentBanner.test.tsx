import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsentBanner } from '../ConsentBanner'

beforeEach(() => {
  window.api = {
    settings: {
      get: vi.fn().mockResolvedValue(false),
      set: vi.fn().mockResolvedValue(undefined)
    }
  } as unknown as typeof window.api
})

describe('ConsentBanner', () => {
  it('shows banner when consentReminderShown is false', async () => {
    render(<ConsentBanner />)

    await waitFor(() => {
      expect(screen.getByText(/zugestimmt/i)).toBeInTheDocument()
    })
  })

  it('hides banner when consentReminderShown is true', async () => {
    vi.mocked(window.api.settings.get).mockResolvedValue(true)
    render(<ConsentBanner />)

    // Wait for the settings check to complete
    await waitFor(() => {
      expect(window.api.settings.get).toHaveBeenCalledWith('consentReminderShown')
    })

    expect(screen.queryByText(/zugestimmt/i)).not.toBeInTheDocument()
  })

  it('dismisses banner on X click without persisting when checkbox unchecked', async () => {
    const user = userEvent.setup()
    render(<ConsentBanner />)

    await waitFor(() => {
      expect(screen.getByText(/zugestimmt/i)).toBeInTheDocument()
    })

    await user.click(screen.getByLabelText('Hinweis schliessen'))

    expect(screen.queryByText(/zugestimmt/i)).not.toBeInTheDocument()
    expect(window.api.settings.set).not.toHaveBeenCalled()
  })

  it('persists dismissal when checkbox is checked', async () => {
    const user = userEvent.setup()
    render(<ConsentBanner />)

    await waitFor(() => {
      expect(screen.getByText(/zugestimmt/i)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByLabelText('Hinweis schliessen'))

    expect(screen.queryByText(/zugestimmt/i)).not.toBeInTheDocument()
    expect(window.api.settings.set).toHaveBeenCalledWith('consentReminderShown', true)
  })

  it('mentions StGB Art. 179bis', async () => {
    render(<ConsentBanner />)

    await waitFor(() => {
      expect(screen.getByText(/179bis/)).toBeInTheDocument()
    })
  })

  it('shows Nicht mehr anzeigen checkbox', async () => {
    render(<ConsentBanner />)

    await waitFor(() => {
      expect(screen.getByText('Nicht mehr anzeigen')).toBeInTheDocument()
    })
  })
})
