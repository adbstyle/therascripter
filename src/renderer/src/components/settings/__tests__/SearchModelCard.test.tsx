import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SearchModelCard from '../SearchModelCard'
import { createMockApi, emitApiEvent } from '../../../test/mockApi'
import type { SearchModelState } from '../../../../../shared/types/Search'

function mount(model: SearchModelState, retry?: SearchModelState): void {
  window.api = createMockApi({
    search: {
      open: vi.fn().mockResolvedValue({ model }),
      retryModel: vi.fn().mockResolvedValue({ model: retry ?? model })
    }
  })
  render(<SearchModelCard />)
}

beforeEach(() => vi.restoreAllMocks())

describe('SearchModelCard', () => {
  it('bereit: ohne Aktivieren, Löschen oder Erneut versuchen', async () => {
    mount({ status: 'ready' })
    expect(await screen.findByRole('status')).toHaveTextContent('Bereit')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('wird geladen: Fortschritt als progressbar, Hinweis, dass alles andere geht (#210 AK 3/4)', async () => {
    mount({ status: 'downloading', progress: 42 })
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByRole('status')).toHaveTextContent('Wird geladen')
    expect(screen.getByText(/sobald das Suchmodell geladen ist/)).toBeInTheDocument()
  })

  it('nächster Versuch: Uhrzeit und Grund (#210 AK 5)', async () => {
    const at = new Date(2026, 10, 14, 14, 5).toISOString()
    mount({ status: 'retry-scheduled', reason: 'network', nextAttemptAt: at })
    expect(await screen.findByRole('status')).toHaveTextContent('Nächster Versuch um 14:05')
    expect(screen.getByText(/Internetverbindung/)).toBeInTheDocument()
  })

  it('Fehler: Grund und «Erneut versuchen» mit gefülltem Knopf', async () => {
    mount({ status: 'failed', reason: 'disk-space' }, { status: 'downloading', progress: 0 })
    expect(await screen.findByRole('status')).toHaveTextContent('Laden fehlgeschlagen')
    expect(screen.getByText(/nicht genügend Speicherplatz/)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Erneut versuchen' })
    expect(button.className).toContain('bg-primary-solid')
    await userEvent.click(button)
    expect(window.api.search.retryModel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Wird geladen'))
  })

  it('noch nicht verfügbar: eigener Zustand ohne Knopf', async () => {
    mount({ status: 'unpublished' })
    expect(await screen.findByRole('status')).toHaveTextContent('Noch nicht verfügbar')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('folgt dem Event search:availabilityChanged', async () => {
    mount({ status: 'downloading', progress: 10 })
    await screen.findByRole('progressbar')
    act(() =>
      emitApiEvent(window.api, 'search.onAvailabilityChanged', { model: { status: 'ready' } })
    )
    expect(screen.getByRole('status')).toHaveTextContent('Bereit')
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
