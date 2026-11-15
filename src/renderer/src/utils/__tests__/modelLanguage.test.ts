import { describe, it, expect } from 'vitest'
import { formatModelLanguage } from '../modelLanguage'

describe('formatModelLanguage', () => {
  it('schreibt die Sprachen des Katalogs aus', () => {
    expect(formatModelLanguage('multi')).toBe('Multilingual')
    expect(formatModelLanguage('de')).toBe('Hochdeutsch')
    expect(formatModelLanguage('en')).toBe('Englisch')
  })

  it('lässt unbekannte Kürzel stehen', () => {
    expect(formatModelLanguage('fr')).toBe('fr')
  })
})
