import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SummaryPanel } from '../SummaryPanel'

const makeApi = (
  over: { get?: ReturnType<typeof vi.fn>; updateText?: ReturnType<typeof vi.fn> } = {}
): { summary: { get: ReturnType<typeof vi.fn>; updateText: ReturnType<typeof vi.fn>; updateTitle: ReturnType<typeof vi.fn> } } => ({
  summary: {
    get: over.get ?? vi.fn().mockResolvedValue(null),
    updateText: over.updateText ?? vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined)
  }
})

beforeEach(() => {
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi()
})

describe('SummaryPanel', () => {
  it('renders null when there is no summary', async () => {
    const { container } = render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => {
      expect(window.api.summary.get).toHaveBeenCalledWith('abc')
    })
    expect(container.firstChild).toBeNull()
  })

  it('renders the summary text when present', async () => {
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi({
      get: vi.fn().mockResolvedValue({
        title: 'Kurztitel',
        text: 'Eine Zusammenfassung.',
        modelId: 'gemma-summarization',
        summarizedAt: '2026-04-24T10:00:00Z'
      })
    })
    render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => expect(screen.getByText('Eine Zusammenfassung.')).toBeDefined())
  })

  it('persists an edit via summary:updateText on blur', async () => {
    const updateText = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi({
      get: vi.fn().mockResolvedValue({
        title: null,
        text: 'Alter Text.',
        modelId: null,
        summarizedAt: null
      }),
      updateText
    })
    render(<SummaryPanel sessionId="abc" />)
    const para = await screen.findByText('Alter Text.')
    para.textContent = 'Neuer Text.'
    fireEvent.blur(para)
    await waitFor(() => {
      expect(updateText).toHaveBeenCalledWith('abc', 'Neuer Text.')
    })
  })

  it('does not persist on Escape (reverts to original)', async () => {
    const updateText = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi({
      get: vi.fn().mockResolvedValue({
        title: null,
        text: 'Original.',
        modelId: null,
        summarizedAt: null
      }),
      updateText
    })
    render(<SummaryPanel sessionId="abc" />)
    const para = await screen.findByText('Original.')
    para.textContent = 'Draft.'
    fireEvent.keyDown(para, { key: 'Escape' })
    expect(updateText).not.toHaveBeenCalled()
  })
})
