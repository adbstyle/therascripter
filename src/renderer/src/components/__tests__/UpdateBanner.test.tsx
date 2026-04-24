import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UpdateBanner from '../UpdateBanner'
import type { PendingModelUpdate } from '../../../../shared/types/ModelUpdate'

const makeUpdate = (id: string, sizeBytes: number): PendingModelUpdate => ({
  id,
  version: '2025-02-01',
  label: `Modell ${id}`,
  url: 'https://example.com/model.bin',
  sha256: 'a'.repeat(64),
  sizeBytes,
  relativePath: 'asr/model.bin',
  archive: false,
  checkPath: 'asr/model.bin'
})

describe('UpdateBanner', () => {
  it('displays update count and size for a single update', () => {
    const onRestart = vi.fn()
    render(
      <UpdateBanner
        updates={[makeUpdate('whisper-large-v3-turbo', 100 * 1024 * 1024)]}
        onRestart={onRestart}
      />
    )

    expect(screen.getByText(/1 Modell/)).toBeInTheDocument()
    expect(screen.getByText(/100 MB/)).toBeInTheDocument()
  })

  it('displays plural for multiple updates', () => {
    render(
      <UpdateBanner
        updates={[
          makeUpdate('whisper-large-v3-turbo', 50 * 1024 * 1024),
          makeUpdate('pyannote-suite', 30 * 1024 * 1024)
        ]}
        onRestart={vi.fn()}
      />
    )

    expect(screen.getByText(/2 Modelle/)).toBeInTheDocument()
  })

  it('calls onRestart when button is clicked', async () => {
    const user = userEvent.setup()
    const onRestart = vi.fn()
    render(
      <UpdateBanner updates={[makeUpdate('whisper-large-v3-turbo', 100)]} onRestart={onRestart} />
    )

    await user.click(screen.getByRole('button', { name: /neu starten/i }))
    expect(onRestart).toHaveBeenCalledOnce()
  })

  it('shows size in GB for large updates', () => {
    render(
      <UpdateBanner
        updates={[makeUpdate('flair-ner-german-large', 2 * 1024 * 1024 * 1024)]}
        onRestart={vi.fn()}
      />
    )

    expect(screen.getByText(/2\.0 GB/)).toBeInTheDocument()
  })

  it('renders the restart button', () => {
    render(<UpdateBanner updates={[makeUpdate('test', 1000)]} onRestart={vi.fn()} />)
    expect(screen.getByRole('button', { name: /neu starten/i })).toBeInTheDocument()
  })
})
