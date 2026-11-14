import { describe, it, expect } from 'vitest'
import {
  cleanDossierText,
  hasControlChars,
  hasControlCharsExceptLineBreaks,
  isBlankDossierText,
  normalizeDossierKey
} from '../dossier-normalize'

// #204 AK 7: gleich, wenn sie sich nur in Gross-/Kleinschreibung, Leerzeichen
// am Anfang/Ende oder der Schreibweise von Umlauten unterscheiden.
describe('normalizeDossierKey', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(normalizeDossierKey('  Anna  ')).toBe('anna')
    expect(normalizeDossierKey('MEIER')).toBe(normalizeDossierKey('meier'))
    expect(normalizeDossierKey('\tPD-1188\n')).toBe('pd-1188')
  })

  it('treats umlauts and their two-letter spelling as equal', () => {
    expect(normalizeDossierKey('Müller')).toBe('mueller')
    expect(normalizeDossierKey('Mueller')).toBe('mueller')
    expect(normalizeDossierKey('Göldi')).toBe(normalizeDossierKey('Goeldi'))
    expect(normalizeDossierKey('Bär')).toBe(normalizeDossierKey('Baer'))
  })

  it('normalizes upper-case umlauts', () => {
    expect(normalizeDossierKey('ÄRNI')).toBe('aerni')
    expect(normalizeDossierKey('ÖZTÜRK')).toBe(normalizeDossierKey('Oeztuerk'))
    expect(normalizeDossierKey('ÜBERSAX')).toBe('uebersax')
  })

  it('composes decomposed (NFD) input from macOS before the umlaut rule', () => {
    const nfd = 'Mu\u0308ller'
    expect(nfd).not.toBe('Müller')
    expect(normalizeDossierKey(nfd)).toBe('mueller')
    expect(normalizeDossierKey('A\u0308rni')).toBe(normalizeDossierKey('Ärni'))
  })

  it('maps ß and capital ẞ to ss', () => {
    expect(normalizeDossierKey('Strauß')).toBe('strauss')
    expect(normalizeDossierKey('STRAUẞ')).toBe('strauss')
    expect(normalizeDossierKey('Strauss')).toBe('strauss')
  })

  it('keeps inner whitespace and other characters', () => {
    expect(normalizeDossierKey('Anna Lena')).toBe('anna lena')
    expect(normalizeDossierKey('Anna Lena')).not.toBe(normalizeDossierKey('AnnaLena'))
    expect(normalizeDossierKey('Rossé')).toBe('rossé')
  })
})

describe('cleanDossierText', () => {
  it('trims and composes, but keeps case and umlauts for display', () => {
    expect(cleanDossierText('  Mu\u0308ller ')).toBe('Müller')
  })
})

// Review #217: Steuerzeichen und unsichtbare Zeichen
describe('invisible and control characters', () => {
  it('ignores zero-width characters and BOM for equality and display', () => {
    expect(normalizeDossierKey('\u200BAn\u200Cna\u200D\uFEFF')).toBe('anna')
    expect(cleanDossierText('\uFEFF Anna \u200B')).toBe('Anna')
  })

  it('treats whitespace and invisible characters only as blank', () => {
    expect(isBlankDossierText(' \u200B\u200C\u200D\uFEFF\t ')).toBe(true)
    expect(isBlankDossierText('\u200BA')).toBe(false)
  })

  it('finds control characters, free-text variant allows line breaks and tab', () => {
    for (const c of ['\u0000', '\u0001', '\u001F', '\u007F', '\n', '\t', '\r']) {
      expect(hasControlChars(`A${c}B`)).toBe(true)
    }
    expect(hasControlChars('Anna Müller-Meier')).toBe(false)
    for (const ok of ['Zeile 1\nZeile 2', 'a\tb', 'a\r\nb']) {
      expect(hasControlCharsExceptLineBreaks(ok)).toBe(false)
    }
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u000Bb', 'a\u000Cb', 'a\u001Bb', 'a\u007Fb']) {
      expect(hasControlCharsExceptLineBreaks(bad)).toBe(true)
    }
  })
})
