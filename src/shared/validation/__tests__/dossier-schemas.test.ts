import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DossierCreateSchema,
  DossierDeleteSchema,
  DossierIdInputSchema,
  DossierUpdateSchema,
  DossiersChangedSchema,
  PastOrTodayIsoDateSchema,
  SessionDocumentDateSchema
} from '../dossier-schemas'

describe('DossierCreateSchema', () => {
  it('accepts first and last name only', () => {
    expect(DossierCreateSchema.safeParse({ firstName: 'Anna', lastName: 'Meier' }).success).toBe(
      true
    )
  })

  it('accepts all optional fields', () => {
    const parsed = DossierCreateSchema.safeParse({
      firstName: 'Anna',
      lastName: 'Meier',
      externalId: 'PD-1188',
      birthDate: '1978-02-03',
      confirmDuplicate: true
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts null for external id and birth date', () => {
    expect(
      DossierCreateSchema.safeParse({
        firstName: 'Anna',
        lastName: 'Meier',
        externalId: null,
        birthDate: null
      }).success
    ).toBe(true)
  })

  it('requires both names, whitespace counts as empty (AK 2)', () => {
    expect(DossierCreateSchema.safeParse({ firstName: 'Anna' }).success).toBe(false)
    expect(DossierCreateSchema.safeParse({ firstName: 'Anna', lastName: '' }).success).toBe(false)
    expect(DossierCreateSchema.safeParse({ firstName: '   ', lastName: 'Meier' }).success).toBe(
      false
    )
  })

  it('enforces length limits', () => {
    const name = 'x'.repeat(101)
    expect(DossierCreateSchema.safeParse({ firstName: name, lastName: 'Meier' }).success).toBe(
      false
    )
    expect(
      DossierCreateSchema.safeParse({ firstName: 'A', lastName: 'M', externalId: 'x'.repeat(51) })
        .success
    ).toBe(false)
  })

  it('rejects unknown keys (strict)', () => {
    expect(
      DossierCreateSchema.safeParse({ firstName: 'A', lastName: 'M', diagnoses: 'x' }).success
    ).toBe(false)
  })
})

describe('PastOrTodayIsoDateSchema (AK 8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts today and past days', () => {
    expect(PastOrTodayIsoDateSchema.safeParse('2026-11-14').success).toBe(true)
    expect(PastOrTodayIsoDateSchema.safeParse('1978-02-03').success).toBe(true)
    expect(PastOrTodayIsoDateSchema.safeParse('2024-02-29').success).toBe(true)
  })

  it('rejects tomorrow, impossible and incomplete dates', () => {
    expect(PastOrTodayIsoDateSchema.safeParse('2026-11-15').success).toBe(false)
    expect(PastOrTodayIsoDateSchema.safeParse('2023-02-29').success).toBe(false)
    expect(PastOrTodayIsoDateSchema.safeParse('2020-04-31').success).toBe(false)
    expect(PastOrTodayIsoDateSchema.safeParse('2020-04').success).toBe(false)
    expect(PastOrTodayIsoDateSchema.safeParse('03.02.1978').success).toBe(false)
  })
})

describe('DossierUpdateSchema', () => {
  it('accepts a single-field patch', () => {
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { note: 'Zeile 1\nZeile 2' } })
        .success
    ).toBe(true)
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { externalId: null } }).success
    ).toBe(true)
  })

  it('rejects an empty patch', () => {
    expect(DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: {} }).success).toBe(false)
  })

  it('rejects an empty name and null for names', () => {
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { lastName: ' ' } }).success
    ).toBe(false)
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { firstName: null } }).success
    ).toBe(false)
  })

  it('limits free text to 20000 characters', () => {
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { diagnoses: 'x'.repeat(20000) } })
        .success
    ).toBe(true)
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { diagnoses: 'x'.repeat(20001) } })
        .success
    ).toBe(false)
  })

  it('rejects unknown patch keys', () => {
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { createdAt: 'x' } }).success
    ).toBe(false)
  })
})

describe('id, delete and event schemas', () => {
  it('validates dossier ids', () => {
    expect(DossierIdInputSchema.safeParse({ dossierId: 'abc' }).success).toBe(true)
    expect(DossierIdInputSchema.safeParse({ dossierId: '' }).success).toBe(false)
    expect(DossierIdInputSchema.safeParse({ dossierId: 'x'.repeat(65) }).success).toBe(false)
  })

  it('requires a fingerprint of at most 128 characters', () => {
    expect(DossierDeleteSchema.safeParse({ dossierId: 'd', fingerprint: 'f' }).success).toBe(true)
    expect(DossierDeleteSchema.safeParse({ dossierId: 'd' }).success).toBe(false)
    expect(
      DossierDeleteSchema.safeParse({ dossierId: 'd', fingerprint: 'f'.repeat(129) }).success
    ).toBe(false)
  })

  it('parses dossiers:changed payloads', () => {
    expect(DossiersChangedSchema.safeParse({ deletedIds: [] }).success).toBe(true)
    expect(DossiersChangedSchema.safeParse({ deletedIds: ['a'] }).success).toBe(true)
    expect(DossiersChangedSchema.safeParse({}).success).toBe(false)
  })
})

// Review #217: NUL und andere Steuerzeichen, unsichtbare Zeichen
describe('control and invisible characters', () => {
  it('rejects control characters in names and dossier id, including line breaks', () => {
    for (const c of ['\u0000', '\u0001', '\n', '\t', '\u001F', '\u007F']) {
      expect(DossierCreateSchema.safeParse({ firstName: `An${c}na`, lastName: 'M' }).success).toBe(
        false
      )
      expect(
        DossierCreateSchema.safeParse({ firstName: 'A', lastName: 'M', externalId: `PD${c}1` })
          .success
      ).toBe(false)
      expect(
        DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { lastName: `M${c}` } }).success
      ).toBe(false)
    }
  })

  it('treats a name of whitespace and zero-width characters only as empty', () => {
    expect(
      DossierCreateSchema.safeParse({ firstName: '\u200B \uFEFF', lastName: 'Meier' }).success
    ).toBe(false)
    expect(
      DossierCreateSchema.safeParse({ firstName: '\u200BAnna', lastName: 'Meier' }).success
    ).toBe(true)
  })

  it('free text allows line breaks and tab, but no other control characters', () => {
    const patch = (note: string): boolean =>
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { note } }).success
    expect(patch('Zeile 1\nZeile 2\r\n\tEingerückt')).toBe(true)
    expect(patch('a\u0000b')).toBe(false)
    expect(patch('a\u0007b')).toBe(false)
    expect(patch('a\u007Fb')).toBe(false)
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { diagnoses: 'F32\u0000' } }).success
    ).toBe(false)
    expect(
      DossierUpdateSchema.safeParse({ dossierId: 'd1', patch: { medication: 'x\u001B' } }).success
    ).toBe(false)
  })
})

describe('SessionDocumentDateSchema (#205 AK 21)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 12, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const parse = (documentDate: unknown): boolean =>
    SessionDocumentDateSchema.safeParse({ sessionId: 's1', documentDate }).success

  it('accepts a complete, valid date up to today', () => {
    expect(parse('2026-11-14')).toBe(true)
    expect(parse('2024-02-29')).toBe(true)
  })

  it('rejects tomorrow, impossible and incomplete dates', () => {
    expect(parse('2026-11-15')).toBe(false)
    expect(parse('2025-02-29')).toBe(false)
    expect(parse('2026-04-31')).toBe(false)
    expect(parse('2026-11')).toBe(false)
    expect(parse('14.11.2026')).toBe(false)
  })

  it('rejects years before 1900 with the German message (Review #223)', () => {
    expect(parse('1899-12-31')).toBe(false)
    expect(parse('0026-11-02')).toBe(false)
    const result = SessionDocumentDateSchema.safeParse({
      sessionId: 's1',
      documentDate: '0026-11-02'
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('Bitte ein Datum ab 1900 eingeben.')
    expect(PastOrTodayIsoDateSchema.safeParse('1850-01-01').success).toBe(false)
  })

  it('never accepts null — a document date cannot be reset (OOS 3)', () => {
    expect(parse(null)).toBe(false)
    expect(parse(undefined)).toBe(false)
  })

  it('rejects unknown keys', () => {
    expect(
      SessionDocumentDateSchema.safeParse({ sessionId: 's1', documentDate: '2026-11-01', x: 1 })
        .success
    ).toBe(false)
  })
})
