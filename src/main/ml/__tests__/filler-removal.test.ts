import { describe, it, expect } from 'vitest'
import { removeFillerWords, rebuildSegments } from '../filler-removal'
import type { TranscriptWord } from '../../../shared/types'

function word(text: string, start: number, end: number): TranscriptWord {
  return { text, start, end }
}

describe('removeFillerWords', () => {
  it('removes äh and ähm', () => {
    const words = [word('Ich', 0, 0.5), word('äh', 0.6, 0.8), word('denke', 0.9, 1.2)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('Ich', 0, 0.5), word('denke', 0.9, 1.2)])
  })

  it('removes Ähm (case-insensitive via pattern)', () => {
    const words = [word('Ähm', 0, 0.3), word('ja', 0.4, 0.5)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('ja', 0.4, 0.5)])
  })

  it('removes ah, ahm variants', () => {
    const words = [word('ah', 0, 0.2), word('ahm', 0.3, 0.5), word('gut', 0.6, 0.8)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('gut', 0.6, 0.8)])
  })

  it('removes uh, uhm variants', () => {
    const words = [word('uh', 0, 0.2), word('uhm', 0.3, 0.5), word('okay', 0.6, 0.8)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('okay', 0.6, 0.8)])
  })

  it('removes hm, hmm variants', () => {
    const words = [word('hm', 0, 0.2), word('hmm', 0.3, 0.5), word('ja', 0.6, 0.7)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('ja', 0.6, 0.7)])
  })

  it('removes mhm variants', () => {
    const words = [word('mhm', 0, 0.3), word('genau', 0.4, 0.7)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('genau', 0.4, 0.7)])
  })

  it('removes fillers with trailing punctuation', () => {
    const words = [word('äh,', 0, 0.3), word('ja.', 0.4, 0.7)]
    const result = removeFillerWords(words)
    expect(result).toEqual([word('ja.', 0.4, 0.7)])
  })

  it('preserves real words that look similar', () => {
    const words = [word('Uhr', 0, 0.3), word('Ahnung', 0.4, 0.7), word('Humor', 0.8, 1.1)]
    const result = removeFillerWords(words)
    expect(result).toEqual(words)
  })

  it('preserves real filler words like also, eigentlich (Entscheidung #33)', () => {
    const words = [word('also', 0, 0.3), word('eigentlich', 0.4, 0.8), word('sozusagen', 0.9, 1.3)]
    const result = removeFillerWords(words)
    expect(result).toEqual(words)
  })

  it('handles empty array', () => {
    expect(removeFillerWords([])).toEqual([])
  })
})

describe('rebuildSegments', () => {
  it('splits on sentence-ending punctuation', () => {
    const words = [
      word('Hallo.', 0, 0.5),
      word('Wie', 0.6, 0.8),
      word('geht', 0.9, 1.1),
      word('es?', 1.2, 1.5)
    ]
    const segments = rebuildSegments(words)
    expect(segments).toEqual([
      { text: 'Hallo.', start: 0, end: 0.5 },
      { text: 'Wie geht es?', start: 0.6, end: 1.5 }
    ])
  })

  it('creates single segment for text without sentence endings', () => {
    const words = [word('Hallo', 0, 0.3), word('Welt', 0.4, 0.6)]
    const segments = rebuildSegments(words)
    expect(segments).toEqual([{ text: 'Hallo Welt', start: 0, end: 0.6 }])
  })

  it('handles empty array', () => {
    expect(rebuildSegments([])).toEqual([])
  })

  it('handles exclamation marks', () => {
    const words = [word('Super!', 0, 0.5), word('Danke', 0.6, 0.9)]
    const segments = rebuildSegments(words)
    expect(segments).toEqual([
      { text: 'Super!', start: 0, end: 0.5 },
      { text: 'Danke', start: 0.6, end: 0.9 }
    ])
  })
})
