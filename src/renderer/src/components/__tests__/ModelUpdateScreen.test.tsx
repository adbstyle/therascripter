import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelUpdateScreen from '../ModelUpdateScreen'
import type { PendingModelUpdate } from '../../../../shared/types/ModelUpdate'

const update: PendingModelUpdate = {
  id: 'whisper-large-v3-turbo',
  version: '2025-02-01',
  label: 'Whisper Large V3 Turbo',
  url: 'https://example.com/model.bin',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024 * 1024,
  relativePath: 'asr/model.bin',
  archive: false,
  checkPath: 'asr/model.bin'
}

const mockModelUpdate = {
  startDownload: vi.fn().mockResolvedValue(undefined),
  clearPending: vi.fn().mockResolvedValue(undefined),
  dismissVersions: vi.fn().mockResolvedValue(undefined),
  onDownloadProgress: vi.fn().mockReturnValue(() => {}),
  onDownloadComplete: vi.fn().mockReturnValue(() => {}),
  onDownloadError: vi.fn().mockReturnValue(() => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  // @ts-expect-error — partial test stub for window.api
  window.api = { modelUpdate: mockModelUpdate }
})

describe('ModelUpdateScreen — pre-download exits (Story G)', () => {
  it('"Später" calls onComplete without clearing or dismissing', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<ModelUpdateScreen updates={[update]} onComplete={onComplete} />)

    await user.click(screen.getByRole('button', { name: /^Später$/i }))

    expect(onComplete).toHaveBeenCalledOnce()
    expect(mockModelUpdate.clearPending).not.toHaveBeenCalled()
    expect(mockModelUpdate.dismissVersions).not.toHaveBeenCalled()
  })

  it('"Diese Version überspringen" dismisses the manifest entry and clears pending', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<ModelUpdateScreen updates={[update]} onComplete={onComplete} />)

    await user.click(screen.getByRole('button', { name: /Diese Version überspringen/i }))

    expect(mockModelUpdate.dismissVersions).toHaveBeenCalledWith([update])
    expect(mockModelUpdate.clearPending).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('"Update starten" begins the download', async () => {
    const user = userEvent.setup()
    render(<ModelUpdateScreen updates={[update]} onComplete={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Update starten/i }))

    expect(mockModelUpdate.startDownload).toHaveBeenCalledOnce()
    // Pre-download dismiss/skip controls are no longer rendered once started.
    expect(screen.queryByRole('button', { name: /^Später$/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Diese Version überspringen/i })
    ).not.toBeInTheDocument()
  })
})
