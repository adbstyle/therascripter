import { describe, it, expect } from 'vitest'
import { findNormalizedRanges, normalizeSearchText, normalizeWithMap } from '../search-normalize'
import { normalizeDossierKey } from '../dossier-normalize'

describe('normalizeSearchText', () => {
  it('ignores case and the spelling of umlauts (#209 AK 3)', () => {
    expect(normalizeSearchText('Prüfungsangst')).toBe('pruefungsangst')
    expect(normalizeSearchText('PRUEFUNGSANGST')).toBe('pruefungsangst')
    expect(normalizeSearchText('Strasse Straße STRASSE')).toBe('strasse strasse strasse')
    expect(normalizeSearchText('ÄÖÜ äöü')).toBe('aeoeue aeoeue')
  })

  it('composes decomposed umlauts (macOS input) and drops zero-width characters', () => {
    expect(normalizeSearchText('Mu\u0308ller')).toBe('mueller')
    expect(normalizeSearchText('An\u200Bna')).toBe('anna')
  })

  it('follows the rule of normalizeDossierKey for trimmed input', () => {
    for (const s of ['Müller', 'ÖZTÜRK', 'Strauß', 'PD-4417-Ä']) {
      expect(normalizeSearchText(s)).toBe(normalizeDossierKey(s))
    }
  })
})

describe('normalizeWithMap', () => {
  const samples = ['Müller', 'Mu\u0308ller und Ärger', 'Straße · ÜBER', 'An\u200Bna', 'plain text']

  it('yields the same text as normalizeSearchText', () => {
    for (const s of samples) expect(normalizeWithMap(s).normalized).toBe(normalizeSearchText(s))
  })

  it('maps every normalized position back to the original text', () => {
    const { normalized, toOriginal } = normalizeWithMap('Ärger')
    expect(normalized).toBe('aerger')
    expect(toOriginal).toEqual([0, 0, 1, 2, 3, 4, 5])
  })

  it('finds ranges in the original text, whole characters only', () => {
    const text = 'Frau Müller und Herr Mueller'
    const ranges = findNormalizedRanges(normalizeWithMap(text), 'mueller')
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(['Müller', 'Mueller'])
    // Anfrage endet mitten in «ü» → das ganze Zeichen gehört zur Markierung
    const partial = findNormalizedRanges(normalizeWithMap('Müller'), 'mu')
    expect(partial).toEqual([{ start: 0, end: 2 }])
  })

  it('maps decomposed characters to their cluster', () => {
    const text = 'Mu\u0308ller'
    const [range] = findNormalizedRanges(normalizeWithMap(text), 'mueller')
    expect(range).toEqual({ start: 0, end: text.length })
  })
})
