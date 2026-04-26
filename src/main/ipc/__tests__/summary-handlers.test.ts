import { describe, it, expect, vi } from 'vitest'
import {
  handleSummaryGet,
  handleSummaryUpdateTitle,
  handleSummaryUpdateText
} from '../summary-handlers'

const makeDeps = (
  over: {
    getSummary?: ReturnType<typeof vi.fn>
    updateTitle?: ReturnType<typeof vi.fn>
    updateSummaryText?: ReturnType<typeof vi.fn>
  } = {}
) => ({
  sessionService: {
    getSummary: over.getSummary ?? vi.fn().mockReturnValue(null),
    updateTitle: over.updateTitle ?? vi.fn(),
    updateSummaryText: over.updateSummaryText ?? vi.fn()
  }
})

describe('summary:get', () => {
  it('rejects empty sessionId', () => {
    expect(() => handleSummaryGet({ sessionId: '' }, makeDeps())).toThrow()
  })

  it('returns the cached SummaryRecord when present', () => {
    const record = {
      title: 'Kurztitel',
      text: 'Cached.',
      modelId: 'gemma-summarization',
      summarizedAt: '2026-04-24T10:00:00Z'
    }
    const deps = makeDeps({ getSummary: vi.fn().mockReturnValue(record) })
    expect(handleSummaryGet({ sessionId: 'abc' }, deps)).toBe(record)
  })

  it('returns null when no summary', () => {
    expect(handleSummaryGet({ sessionId: 'abc' }, makeDeps())).toBeNull()
  })
})

describe('summary:updateTitle', () => {
  it('rejects empty sessionId', () => {
    expect(() => handleSummaryUpdateTitle({ sessionId: '', title: 'x' }, makeDeps())).toThrow()
  })

  it('rejects title exceeding 120 chars', () => {
    const long = 'x'.repeat(121)
    expect(() => handleSummaryUpdateTitle({ sessionId: 'abc', title: long }, makeDeps())).toThrow()
  })

  it('delegates to SessionService.updateTitle', () => {
    const deps = makeDeps()
    handleSummaryUpdateTitle({ sessionId: 'abc', title: 'Neuer Titel' }, deps)
    expect(deps.sessionService.updateTitle).toHaveBeenCalledWith('abc', 'Neuer Titel')
  })

  it('accepts empty title (resets to date-fallback in view layer)', () => {
    const deps = makeDeps()
    handleSummaryUpdateTitle({ sessionId: 'abc', title: '' }, deps)
    expect(deps.sessionService.updateTitle).toHaveBeenCalledWith('abc', '')
  })
})

describe('summary:updateText', () => {
  it('delegates to SessionService.updateSummaryText', () => {
    const deps = makeDeps()
    handleSummaryUpdateText({ sessionId: 'abc', text: 'Editierte Zusammenfassung.' }, deps)
    expect(deps.sessionService.updateSummaryText).toHaveBeenCalledWith(
      'abc',
      'Editierte Zusammenfassung.'
    )
  })

  it('rejects text exceeding 2000 chars', () => {
    const long = 'x'.repeat(2_001)
    expect(() => handleSummaryUpdateText({ sessionId: 'abc', text: long }, makeDeps())).toThrow()
  })
})
