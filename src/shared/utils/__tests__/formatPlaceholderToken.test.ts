import { describe, it, expect } from 'vitest'
import { formatPlaceholderToken } from '../formatPlaceholderToken'
import type { PlaceholderType, TipTapPlaceholderChipAttrs } from '../../types'

const ALL_TYPES: PlaceholderType[] = [
  'PERSON',
  'ORT',
  'DATUM',
  'KONTAKT',
  'ORGANISATION',
  'MEDIZINISCH',
  'SONSTIGES'
]

describe('formatPlaceholderToken', () => {
  it.each(ALL_TYPES)('formats %s as [TYPE NUMBER]', (type) => {
    expect(formatPlaceholderToken({ type, number: 1 })).toBe(`[${type} 1]`)
  })

  it('keeps multi-digit numbers unpadded', () => {
    expect(formatPlaceholderToken({ type: 'ORT', number: 12 })).toBe('[ORT 12]')
  })

  it('never puts the original (clear-text) value into the token', () => {
    const attrs: TipTapPlaceholderChipAttrs = {
      entityId: 'person-3',
      type: 'PERSON',
      number: 3,
      source: 'manual',
      original: 'Ruth Gerber-Imhof'
    }
    const token = formatPlaceholderToken(attrs)
    expect(token).toBe('[PERSON 3]')
    expect(token).not.toContain('Ruth')
    expect(token).not.toContain('Gerber')
  })

  it('does not even read `original` when handed full chip attrs', () => {
    const attrs = { entityId: 'ort-1', type: 'ORT', number: 1, source: 'ner' } as Record<
      string,
      unknown
    >
    Object.defineProperty(attrs, 'original', {
      enumerable: true,
      get() {
        throw new Error('original must not be read')
      }
    })
    expect(formatPlaceholderToken(attrs as unknown as TipTapPlaceholderChipAttrs)).toBe('[ORT 1]')
  })
})
