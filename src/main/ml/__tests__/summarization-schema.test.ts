import { describe, it, expect } from 'vitest'
import {
  SUMMARIZATION_GBNF,
  SUMMARY_MAX,
  SUMMARY_MIN,
  SummarizationOutputSchema,
  TITLE_MAX,
  TITLE_MIN
} from '../summarization-schema'

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

  it('GBNF grammar repeats char exactly within the Zod bounds', () => {
    // Parsed out of the grammar text instead of re-interpolating the
    // constants — a hand edit of the grammar must fail here.
    const bounds = (rule: string): number[] => {
      const m = SUMMARIZATION_GBNF.match(new RegExp(`^${rule} ::= .*char\\{(\\d+),(\\d+)\\}`, 'm'))
      expect(m, `rule ${rule}`).not.toBeNull()
      return [Number(m![1]), Number(m![2])]
    }
    expect(bounds('title')).toEqual([TITLE_MIN, TITLE_MAX])
    expect(bounds('summary')).toEqual([SUMMARY_MIN, SUMMARY_MAX])
    expect(SUMMARIZATION_GBNF).toMatch(
      /^root ::= "\{" space title-kv "," space summary-kv "\}" space$/m
    )
  })

  it('Zod accepts exactly the boundary values', () => {
    const ok = (title: string, summary: string): boolean =>
      SummarizationOutputSchema.safeParse({ title, summary }).success
    expect(ok('a'.repeat(TITLE_MIN), 'a'.repeat(SUMMARY_MIN))).toBe(true)
    expect(ok('a'.repeat(TITLE_MAX), 'a'.repeat(SUMMARY_MAX))).toBe(true)
    expect(ok('a'.repeat(TITLE_MIN - 1), 'a'.repeat(SUMMARY_MIN))).toBe(false)
    expect(ok('a'.repeat(TITLE_MIN), 'a'.repeat(SUMMARY_MIN - 1))).toBe(false)
  })
})
