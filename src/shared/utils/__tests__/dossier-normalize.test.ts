import { describe, it, expect } from 'vitest'
import { normalizeDossierKey, cleanDossierText } from '../dossier-normalize'

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
    const nfd = 'Müller'
    expect(nfd).not.toBe('Müller')
    expect(normalizeDossierKey(nfd)).toBe('mueller')
    expect(normalizeDossierKey('Ärni')).toBe(normalizeDossierKey('Ärni'))
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
    expect(cleanDossierText('  Müller ')).toBe('Müller')
  })
})
