import { describe, it, expect } from 'vitest'
import { dehyphenateOCRText } from '../VisionOCRService'

describe('dehyphenateOCRText', () => {
  it('merges hyphenated line breaks', () => {
    expect(dehyphenateOCRText('Al-\ntersheim')).toBe('Altersheim')
  })

  it('merges multiple hyphenated breaks', () => {
    expect(dehyphenateOCRText('Al-\ntersheim und Kran-\nkenhaus')).toBe(
      'Altersheim und Krankenhaus'
    )
  })

  it('handles umlauts', () => {
    expect(dehyphenateOCRText('Über-\nführung')).toBe('Überführung')
    expect(dehyphenateOCRText('grü-\nssen')).toBe('grüssen')
  })

  it('preserves hyphens before uppercase (compound names)', () => {
    expect(dehyphenateOCRText('Zürich-\nOerlikon')).toBe('Zürich-\nOerlikon')
  })

  it('preserves hyphens without newline', () => {
    expect(dehyphenateOCRText('Zürich-Oerlikon')).toBe('Zürich-Oerlikon')
  })

  it('preserves regular newlines without hyphens', () => {
    expect(dehyphenateOCRText('Zeile eins\nZeile zwei')).toBe('Zeile eins\nZeile zwei')
  })

  it('returns empty string unchanged', () => {
    expect(dehyphenateOCRText('')).toBe('')
  })

  it('handles text without any hyphens', () => {
    expect(dehyphenateOCRText('Normaler Text ohne Trennung')).toBe('Normaler Text ohne Trennung')
  })
})
