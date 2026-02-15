import { describe, it, expect } from 'vitest'
import { ReviewLoadSchema, ReviewSaveSchema } from '../review-schemas'

describe('ReviewLoadSchema', () => {
  it('accepts valid sessionId', () => {
    const result = ReviewLoadSchema.parse({ sessionId: 'abc-123' })
    expect(result.sessionId).toBe('abc-123')
  })

  it('rejects empty sessionId', () => {
    expect(() => ReviewLoadSchema.parse({ sessionId: '' })).toThrow()
  })

  it('rejects missing sessionId', () => {
    expect(() => ReviewLoadSchema.parse({})).toThrow()
  })
})

describe('ReviewSaveSchema', () => {
  const validInput = {
    sessionId: 'abc-123',
    document: {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
    },
    entityMap: {
      e1: {
        original: 'Max',
        placeholder: '[PERSON 1]',
        type: 'PERSON' as const,
        source: 'ner' as const
      }
    }
  }

  it('accepts valid save input', () => {
    const result = ReviewSaveSchema.parse(validInput)
    expect(result.sessionId).toBe('abc-123')
    expect(result.document.type).toBe('doc')
    expect(result.entityMap['e1'].type).toBe('PERSON')
  })

  it('accepts empty entityMap', () => {
    const input = { ...validInput, entityMap: {} }
    const result = ReviewSaveSchema.parse(input)
    expect(Object.keys(result.entityMap)).toHaveLength(0)
  })

  it('accepts all entity types', () => {
    const types = ['PERSON', 'ORT', 'DATUM', 'KONTAKT', 'ORGANISATION', 'MEDIZINISCH', 'SONSTIGES']
    for (const type of types) {
      const input = {
        ...validInput,
        entityMap: {
          e1: { original: 'x', placeholder: '[X 1]', type, source: 'ner' }
        }
      }
      expect(() => ReviewSaveSchema.parse(input)).not.toThrow()
    }
  })

  it('accepts all source types', () => {
    const sources = ['ner', 'blocklist', 'manual']
    for (const source of sources) {
      const input = {
        ...validInput,
        entityMap: {
          e1: { original: 'x', placeholder: '[X 1]', type: 'PERSON', source }
        }
      }
      expect(() => ReviewSaveSchema.parse(input)).not.toThrow()
    }
  })

  it('rejects invalid entity type', () => {
    const input = {
      ...validInput,
      entityMap: {
        e1: { original: 'x', placeholder: '[X 1]', type: 'INVALID', source: 'ner' }
      }
    }
    expect(() => ReviewSaveSchema.parse(input)).toThrow()
  })

  it('rejects invalid source', () => {
    const input = {
      ...validInput,
      entityMap: {
        e1: { original: 'x', placeholder: '[X 1]', type: 'PERSON', source: 'unknown' }
      }
    }
    expect(() => ReviewSaveSchema.parse(input)).toThrow()
  })

  it('rejects wrong document type', () => {
    const input = { ...validInput, document: { type: 'paragraph', content: [] } }
    expect(() => ReviewSaveSchema.parse(input)).toThrow()
  })

  it('rejects missing sessionId', () => {
    const { sessionId: _, ...rest } = validInput
    expect(() => ReviewSaveSchema.parse(rest)).toThrow()
  })
})
