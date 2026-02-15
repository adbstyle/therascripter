import { describe, it, expect } from 'vitest'
import {
  BlocklistAddSchema,
  BlocklistUpdateSchema,
  BlocklistDeleteSchema
} from '../blocklist-schemas'

describe('BlocklistAddSchema', () => {
  it('accepts valid input', () => {
    const result = BlocklistAddSchema.parse({ term: 'Zürich', placeholderType: 'ORT' })
    expect(result.term).toBe('Zürich')
    expect(result.placeholderType).toBe('ORT')
  })

  it('accepts all 7 placeholder types', () => {
    const types = [
      'PERSON',
      'ORT',
      'DATUM',
      'KONTAKT',
      'ORGANISATION',
      'MEDIZINISCH',
      'SONSTIGES'
    ]
    for (const type of types) {
      const result = BlocklistAddSchema.parse({ term: 'Test', placeholderType: type })
      expect(result.placeholderType).toBe(type)
    }
  })

  it('rejects empty term', () => {
    expect(() => BlocklistAddSchema.parse({ term: '', placeholderType: 'PERSON' })).toThrow()
  })

  it('rejects term over 200 chars', () => {
    expect(() =>
      BlocklistAddSchema.parse({ term: 'x'.repeat(201), placeholderType: 'PERSON' })
    ).toThrow()
  })

  it('accepts term at exactly 200 chars', () => {
    const result = BlocklistAddSchema.parse({
      term: 'x'.repeat(200),
      placeholderType: 'PERSON'
    })
    expect(result.term).toHaveLength(200)
  })

  it('rejects invalid placeholder type', () => {
    expect(() =>
      BlocklistAddSchema.parse({ term: 'Test', placeholderType: 'INVALID' })
    ).toThrow()
  })

  it('rejects missing term', () => {
    expect(() => BlocklistAddSchema.parse({ placeholderType: 'PERSON' })).toThrow()
  })

  it('rejects missing placeholderType', () => {
    expect(() => BlocklistAddSchema.parse({ term: 'Test' })).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => BlocklistAddSchema.parse('Zürich')).toThrow()
  })
})

describe('BlocklistUpdateSchema', () => {
  it('accepts valid input', () => {
    const result = BlocklistUpdateSchema.parse({
      id: 'abc-123',
      term: 'Bern',
      placeholderType: 'ORT'
    })
    expect(result.id).toBe('abc-123')
    expect(result.term).toBe('Bern')
    expect(result.placeholderType).toBe('ORT')
  })

  it('rejects empty id', () => {
    expect(() =>
      BlocklistUpdateSchema.parse({ id: '', term: 'Test', placeholderType: 'PERSON' })
    ).toThrow()
  })

  it('rejects empty term', () => {
    expect(() =>
      BlocklistUpdateSchema.parse({ id: 'abc', term: '', placeholderType: 'PERSON' })
    ).toThrow()
  })

  it('rejects term over 200 chars', () => {
    expect(() =>
      BlocklistUpdateSchema.parse({
        id: 'abc',
        term: 'x'.repeat(201),
        placeholderType: 'PERSON'
      })
    ).toThrow()
  })

  it('rejects missing id', () => {
    expect(() =>
      BlocklistUpdateSchema.parse({ term: 'Test', placeholderType: 'PERSON' })
    ).toThrow()
  })
})

describe('BlocklistDeleteSchema', () => {
  it('accepts valid input', () => {
    const result = BlocklistDeleteSchema.parse({ id: 'abc-123' })
    expect(result.id).toBe('abc-123')
  })

  it('rejects empty id', () => {
    expect(() => BlocklistDeleteSchema.parse({ id: '' })).toThrow()
  })

  it('rejects missing id', () => {
    expect(() => BlocklistDeleteSchema.parse({})).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => BlocklistDeleteSchema.parse('abc-123')).toThrow()
  })
})
