import { describe, it, expect } from 'vitest'
import { isSpecialToken, filterSpecialTokens, mergeSubTokens } from '../token-processing'
import type { WhisperToken } from '../token-processing'

function tok(text: string, from: number, to: number): WhisperToken {
  return { text, offsets: { from, to }, id: 0, p: 0.9 }
}

// --- isSpecialToken ---

describe('isSpecialToken', () => {
  it('detects [_BEG_] as special', () => {
    expect(isSpecialToken('[_BEG_]')).toBe(true)
  })

  it('detects [_TT_500] as special', () => {
    expect(isSpecialToken('[_TT_500]')).toBe(true)
  })

  it('detects [_EOT_] as special', () => {
    expect(isSpecialToken('[_EOT_]')).toBe(true)
  })

  it('detects [_SOT_] as special', () => {
    expect(isSpecialToken('[_SOT_]')).toBe(true)
  })

  it('detects [_NOSPEECH_] as special', () => {
    expect(isSpecialToken('[_NOSPEECH_]')).toBe(true)
  })

  it('does not flag normal words', () => {
    expect(isSpecialToken(' Hallo')).toBe(false)
    expect(isSpecialToken('haus')).toBe(false)
    expect(isSpecialToken(' Tag,')).toBe(false)
  })

  it('does not flag empty strings', () => {
    expect(isSpecialToken('')).toBe(false)
    expect(isSpecialToken('  ')).toBe(false)
  })
})

// --- filterSpecialTokens ---

describe('filterSpecialTokens', () => {
  it('removes special tokens from token array', () => {
    const tokens = [
      tok('[_BEG_]', 0, 0),
      tok(' Hallo', 0, 500),
      tok('[_TT_500]', 500, 500),
      tok(' Welt', 500, 1000),
      tok('[_EOT_]', 1000, 1000)
    ]

    const result = filterSpecialTokens(tokens)

    expect(result).toHaveLength(2)
    expect(result[0].text).toBe(' Hallo')
    expect(result[1].text).toBe(' Welt')
  })

  it('returns empty array when all tokens are special', () => {
    const tokens = [tok('[_BEG_]', 0, 0), tok('[_TT_100]', 0, 0)]
    expect(filterSpecialTokens(tokens)).toEqual([])
  })

  it('preserves all tokens when none are special', () => {
    const tokens = [tok(' Guten', 0, 500), tok(' Tag', 500, 1000)]
    expect(filterSpecialTokens(tokens)).toHaveLength(2)
  })
})

// --- mergeSubTokens ---

describe('mergeSubTokens', () => {
  it('merges sub-tokens into whole words based on leading space', () => {
    // "Treibhausgase" = " Tre" + "ib" + "haus" + "g" + "ase"
    const tokens = [
      tok(' Tre', 100, 520),
      tok('ib', 520, 860),
      tok('haus', 860, 1540),
      tok('g', 1540, 1720),
      tok('ase', 1720, 2240)
    ]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('Treibhausgase')
    expect(words[0].start).toBe(0.1)
    expect(words[0].end).toBe(2.24)
  })

  it('handles multiple words with sub-tokens', () => {
    // "Treibhaus" + "gelten" + "als"
    const tokens = [
      tok(' Tre', 100, 520),
      tok('ib', 520, 860),
      tok('haus', 860, 1540),
      tok(' gel', 2240, 2760),
      tok('ten', 2760, 3280),
      tok(' als', 3280, 3790)
    ]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(3)
    expect(words[0].text).toBe('Treibhaus')
    expect(words[0].start).toBe(0.1)
    expect(words[0].end).toBe(1.54)
    expect(words[1].text).toBe('gelten')
    expect(words[1].start).toBe(2.24)
    expect(words[1].end).toBe(3.28)
    expect(words[2].text).toBe('als')
    expect(words[2].start).toBe(3.28)
    expect(words[2].end).toBe(3.79)
  })

  it('handles tokens that are already whole words (all have leading space)', () => {
    const tokens = [tok(' Guten', 0, 500), tok(' Tag,', 500, 1000), tok(' wie', 1000, 1500)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(3)
    expect(words[0].text).toBe('Guten')
    expect(words[1].text).toBe('Tag,')
    expect(words[2].text).toBe('wie')
  })

  it('treats first token as new word even without leading space', () => {
    const tokens = [tok('Hallo', 0, 500), tok(' Welt', 500, 1000)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(2)
    expect(words[0].text).toBe('Hallo')
    expect(words[1].text).toBe('Welt')
  })

  it('merges "wissenschaftlich" from sub-tokens', () => {
    // "wissenschaftlich" = " w" + "issenschaft" + "lich"
    const tokens = [tok(' w', 7700, 7800), tok('issenschaft', 7800, 8530), tok('lich', 8680, 8840)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('wissenschaftlich')
    expect(words[0].start).toBe(7.7)
    expect(words[0].end).toBe(8.84)
  })

  it('merges "Bürokratie" from sub-tokens', () => {
    const tokens = [
      tok(' B', 91220, 91290),
      tok('ü', 91290, 91430),
      tok('rok', 91430, 91640),
      tok('rat', 91640, 91850),
      tok('ie', 91850, 92000)
    ]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('Bürokratie')
    expect(words[0].start).toBe(91.22)
    expect(words[0].end).toBe(92)
  })

  it('skips whitespace-only tokens', () => {
    const tokens = [tok(' Hallo', 0, 500), tok('  ', 500, 500), tok(' Welt', 500, 1000)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(2)
    expect(words[0].text).toBe('Hallo')
    expect(words[1].text).toBe('Welt')
  })

  it('skips empty text tokens', () => {
    const tokens = [tok('', 0, 0), tok(' Hallo', 0, 500)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('Hallo')
  })

  it('returns empty array for empty input', () => {
    expect(mergeSubTokens([])).toEqual([])
  })

  it('handles single token', () => {
    const words = mergeSubTokens([tok(' Hallo', 0, 500)])

    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('Hallo')
  })

  it('preserves punctuation attached to tokens', () => {
    const tokens = [tok(' Tag,', 500, 1000), tok(' wie', 1000, 1500), tok(' gehts?', 1500, 2000)]

    const words = mergeSubTokens(tokens)

    expect(words).toHaveLength(3)
    expect(words[0].text).toBe('Tag,')
    expect(words[2].text).toBe('gehts?')
  })

  it('handles end-to-end: filter then merge', () => {
    // Simulates real pipeline: [_BEG_] + " Tre" + "ib" + "haus" + [_TT_500] + " gel" + "ten"
    const raw = [
      tok('[_BEG_]', 0, 0),
      tok(' Tre', 100, 520),
      tok('ib', 520, 860),
      tok('haus', 860, 1540),
      tok('[_TT_500]', 1540, 1540),
      tok(' gel', 2240, 2760),
      tok('ten', 2760, 3280)
    ]

    const filtered = filterSpecialTokens(raw)
    const words = mergeSubTokens(filtered)

    expect(words).toHaveLength(2)
    expect(words[0].text).toBe('Treibhaus')
    expect(words[1].text).toBe('gelten')
  })
})
