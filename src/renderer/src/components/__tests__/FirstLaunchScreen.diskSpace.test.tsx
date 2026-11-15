import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import FirstLaunchScreen from '../FirstLaunchScreen'
import { renderWithProviders } from '../../test/renderWithProviders'
import { createMockApi } from '../../test/mockApi'

// Zu wenig Platz (Review PR #234, N1): «Verfügbar» abgerundet, «Benötigt»
// ist der dezimale Mindestplatz — knapp darunter stehen nie zwei gleiche Werte.
describe('FirstLaunchScreen — zu wenig Speicherplatz', () => {
  it('zeigt «Verfügbar: 4.9 GB» und «Benötigt: 5.0 GB» bei 4.99 GB frei', async () => {
    window.api = createMockApi({
      modelDownload: {
        checkDiskSpace: vi.fn().mockResolvedValue({
          sufficient: false,
          availableBytes: 4_990_000_000,
          requiredBytes: 2_101_189_732
        })
      }
    })
    renderWithProviders(<FirstLaunchScreen onComplete={vi.fn()} />)
    expect(await screen.findByText('Nicht genügend Speicherplatz')).toBeInTheDocument()
    expect(screen.getByText('Verfügbar: 4.9 GB')).toBeInTheDocument()
    expect(screen.getByText('Benötigt: 5.0 GB')).toBeInTheDocument()
    expect(screen.getByText(/mindestens 5\.0 GB freien/)).toBeInTheDocument()
  })
})
