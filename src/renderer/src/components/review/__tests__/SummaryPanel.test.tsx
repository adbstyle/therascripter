import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SummaryPanel } from '../SummaryPanel'

type TaskCompletedHandler = (data: { sessionId: string; taskType: string }) => void

// Zuletzt registrierter task:completed-Listener — Tests feuern das Event
// darüber (Review-Ungating: Summary lädt nach, wenn die Hintergrund-
// Summarization abschließt).
let taskCompletedHandler: TaskCompletedHandler | null = null

const makeApi = (
  over: { get?: ReturnType<typeof vi.fn>; updateText?: ReturnType<typeof vi.fn> } = {}
): {
  summary: {
    get: ReturnType<typeof vi.fn>
    updateText: ReturnType<typeof vi.fn>
    updateTitle: ReturnType<typeof vi.fn>
  }
  tasks: { onCompleted: ReturnType<typeof vi.fn> }
} => ({
  summary: {
    get: over.get ?? vi.fn().mockResolvedValue(null),
    updateText: over.updateText ?? vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined)
  },
  tasks: {
    onCompleted: vi.fn((cb: TaskCompletedHandler) => {
      taskCompletedHandler = cb
      return () => {
        taskCompletedHandler = null
      }
    })
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

  it('refetches when the background summarization completes (Review-Ungating)', async () => {
    // Editor kann offen sein, bevor die Summary existiert — beim
    // task:completed der Summarization muss der Panel-Inhalt nachladen.
    const get = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        title: 'Titel',
        text: 'Späte Zusammenfassung.',
        modelId: 'gemma-summarization',
        summarizedAt: '2026-04-24T10:00:00Z'
      })
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi({ get })
    const { container } = render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    expect(container.firstChild).toBeNull()

    taskCompletedHandler?.({ sessionId: 'abc', taskType: 'summarization' })
    await screen.findByText('Späte Zusammenfassung.')
  })

  it('ignores task:completed events for other sessions and task types', async () => {
    const get = vi.fn().mockResolvedValue(null)
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = makeApi({ get })
    render(<SummaryPanel sessionId="abc" />)
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    taskCompletedHandler?.({ sessionId: 'other', taskType: 'summarization' })
    taskCompletedHandler?.({ sessionId: 'abc', taskType: 'anonymization' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(get).toHaveBeenCalledTimes(1)
  })
})
