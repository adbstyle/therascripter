import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewSidePanel } from '../ReviewSidePanel'
import type { AnonymizationOverviewData } from '../../../hooks/useAnonymizationOverview'
import type { ProcessedModelsSnapshot } from '../../../../../shared/types'

const SHA = (c: string): string => c.repeat(64)

const emptyAnonymization: AnonymizationOverviewData = {
  groups: [],
  totalIdentities: 0,
  totalChips: 0
}

const anonymizationWithCount: AnonymizationOverviewData = {
  ...emptyAnonymization,
  totalChips: 36
}

const provenanceSnapshot: ProcessedModelsSnapshot = {
  capturedAt: '2026-04-15T14:32:00Z',
  asr: {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo',
    version: '2026-04-01',
    sha256: SHA('a'),
    sizeBytes: 1_700_000_000
  },
  diarization: null,
  ner: null,
  summarization: null
}

function setup(overrides: Partial<Parameters<typeof ReviewSidePanel>[0]> = {}) {
  return render(
    <ReviewSidePanel
      isOpen
      anonymization={emptyAnonymization}
      onRevert={vi.fn()}
      onChangeType={vi.fn()}
      onAddToBlocklist={vi.fn()}
      provenance={null}
      reviewAt={null}
      audioStats={null}
      {...overrides}
    />
  )
}

describe('ReviewSidePanel', () => {
  it('opens with the Pseudonymisierungen tab active', () => {
    setup({ anonymization: anonymizationWithCount })

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[0]).toHaveTextContent(/Pseudonymisierungen/)
    expect(tabs[1]).toHaveTextContent(/Verarbeitung/)
  })

  it('shows the count badge on the Pseudonymisierungen tab', () => {
    setup({ anonymization: anonymizationWithCount })

    const anonTab = screen.getByRole('tab', { name: /Pseudonymisierungen/ })
    expect(within(anonTab).getByText('36')).toBeInTheDocument()
  })

  it('omits the count badge when there are no chips', () => {
    setup({ anonymization: emptyAnonymization })

    const anonTab = screen.getByRole('tab', { name: /Pseudonymisierungen/ })
    expect(within(anonTab).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })

  it('mounts both tabpanels and toggles their hidden attribute on click', async () => {
    const user = userEvent.setup()
    setup({ provenance: provenanceSnapshot })

    const anonPanel = document.getElementById('review-side-panel-anonymization')
    const provPanel = document.getElementById('review-side-panel-provenance')
    expect(anonPanel).not.toBeNull()
    expect(provPanel).not.toBeNull()
    expect(anonPanel).not.toHaveAttribute('hidden')
    expect(provPanel).toHaveAttribute('hidden')

    await user.click(screen.getByRole('tab', { name: /Verarbeitung/ }))

    expect(anonPanel).toHaveAttribute('hidden')
    expect(provPanel).not.toHaveAttribute('hidden')
    expect(screen.getByText('Whisper Large V3 Turbo')).toBeInTheDocument()
  })

  it('wires aria-labelledby and aria-controls between tabs and tabpanels', () => {
    setup()

    const tabs = screen.getAllByRole('tab')
    expect(tabs[0]).toHaveAttribute('id', 'review-side-tab-anonymization')
    expect(tabs[0]).toHaveAttribute('aria-controls', 'review-side-panel-anonymization')
    expect(tabs[1]).toHaveAttribute('id', 'review-side-tab-provenance')
    expect(tabs[1]).toHaveAttribute('aria-controls', 'review-side-panel-provenance')

    const anonPanel = document.getElementById('review-side-panel-anonymization')
    const provPanel = document.getElementById('review-side-panel-provenance')
    expect(anonPanel).toHaveAttribute('aria-labelledby', 'review-side-tab-anonymization')
    expect(provPanel).toHaveAttribute('aria-labelledby', 'review-side-tab-provenance')
  })

  it('marks the inner container inert when isOpen is false', () => {
    const { container } = setup({ isOpen: false })

    const inner = container.querySelector('[inert]')
    expect(inner).not.toBeNull()
    expect(inner).toHaveClass('w-[300px]')
  })

  it('does NOT mark the inner container inert when isOpen is true', () => {
    const { container } = setup({ isOpen: true })

    expect(container.querySelector('[inert]')).toBeNull()
  })
})
