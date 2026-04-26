import { describe, it, expect } from 'vitest'
import { SUMMARIZATION_JSON_SCHEMA, SummarizationOutputSchema } from '../summarization-schema'

describe('summarization-schema', () => {
  it('Zod schema accepts a well-formed result', () => {
    const result = SummarizationOutputSchema.parse({
      title: 'Schlafstörungen und Arbeitsstress',
      summary:
        'Der Patient berichtet von Einschlafproblemen seit drei Wochen. Vereinbart wird ein Schlaftagebuch.'
    })
    expect(result.title).toBeTypeOf('string')
    expect(result.summary).toBeTypeOf('string')
  })

  it('Zod schema rejects missing fields', () => {
    expect(() => SummarizationOutputSchema.parse({ title: 'Nur Titel' })).toThrow()
    expect(() => SummarizationOutputSchema.parse({ summary: 'a'.repeat(50) })).toThrow()
  })

  it('Zod schema rejects oversized title (>80 chars)', () => {
    expect(() =>
      SummarizationOutputSchema.parse({ title: 'a'.repeat(81), summary: 'a'.repeat(50) })
    ).toThrow()
  })

  it('Zod schema rejects oversized summary (>1000 chars)', () => {
    expect(() =>
      SummarizationOutputSchema.parse({ title: 'OK', summary: 'a'.repeat(1001) })
    ).toThrow()
  })

  it('Zod schema rejects too-short title (<3 chars)', () => {
    expect(() =>
      SummarizationOutputSchema.parse({ title: 'AB', summary: 'a'.repeat(50) })
    ).toThrow()
  })

  it('JSON Schema string is valid JSON and matches Zod constraints', () => {
    const parsed = JSON.parse(SUMMARIZATION_JSON_SCHEMA)
    expect(parsed.type).toBe('object')
    expect(parsed.required).toEqual(['title', 'summary'])
    expect(parsed.additionalProperties).toBe(false)
    expect(parsed.properties.title.maxLength).toBe(80)
    expect(parsed.properties.summary.maxLength).toBe(1000)
    expect(parsed.properties.title.minLength).toBe(3)
    expect(parsed.properties.summary.minLength).toBe(20)
  })
})
