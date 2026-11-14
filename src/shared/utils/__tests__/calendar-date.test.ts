import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  formatSwissDate,
  isValidIsoDate,
  BEFORE_MIN_YEAR_MESSAGE,
  isBeforeMinYear,
  isValidIsoDateNotAfter,
  localTodayIso,
  parseSwissDate
} from '../calendar-date'

describe('parseSwissDate', () => {
  it('parses TT.MM.JJJJ to ISO', () => {
    expect(parseSwissDate('03.02.1978')).toBe('1978-02-03')
    expect(parseSwissDate(' 3.2.1978 ')).toBe('1978-02-03')
  })

  it('accepts 29.02. only in leap years', () => {
    expect(parseSwissDate('29.02.2024')).toBe('2024-02-29')
    expect(parseSwissDate('29.02.2000')).toBe('2000-02-29')
    expect(parseSwissDate('29.02.2023')).toBeNull()
    expect(parseSwissDate('29.02.1900')).toBeNull()
  })

  it('rejects days that do not exist', () => {
    expect(parseSwissDate('31.04.2020')).toBeNull()
    expect(parseSwissDate('32.01.2020')).toBeNull()
    expect(parseSwissDate('00.01.2020')).toBeNull()
    expect(parseSwissDate('15.13.2020')).toBeNull()
  })

  it('rejects incomplete input', () => {
    expect(parseSwissDate('03.02.')).toBeNull()
    expect(parseSwissDate('03.02.78')).toBeNull()
    expect(parseSwissDate('1978-02-03')).toBeNull()
    expect(parseSwissDate('')).toBeNull()
  })
})

describe('isValidIsoDate / isValidIsoDateNotAfter', () => {
  it('validates real calendar days', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true)
    expect(isValidIsoDate('2023-02-29')).toBe(false)
    expect(isValidIsoDate('2020-04-31')).toBe(false)
    expect(isValidIsoDate('2020-4-03')).toBe(false)
    expect(isValidIsoDate('0000-01-01')).toBe(false)
  })

  it('allows today, rejects tomorrow', () => {
    expect(isValidIsoDateNotAfter('2026-11-14', '2026-11-14')).toBe(true)
    expect(isValidIsoDateNotAfter('2026-11-13', '2026-11-14')).toBe(true)
    expect(isValidIsoDateNotAfter('2026-11-15', '2026-11-14')).toBe(false)
    expect(isValidIsoDateNotAfter('2026-04-31', '2026-11-14')).toBe(false)
  })
})

describe('localTodayIso with a fixed time zone', () => {
  const originalTz = process.env.TZ

  beforeEach(() => {
    process.env.TZ = 'Europe/Zurich'
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env.TZ = originalTz
  })

  it('uses the local day, not the UTC day, shortly after midnight', () => {
    // 23:30 UTC = 00:30 in Zürich (Winterzeit) — lokal ist schon der 15.
    vi.setSystemTime(new Date('2026-11-14T23:30:00Z'))
    const today = localTodayIso()
    expect(today).toBe('2026-11-15')
    expect(isValidIsoDateNotAfter('2026-11-15', today)).toBe(true)
    expect(isValidIsoDateNotAfter('2026-11-16', today)).toBe(false)
  })

  it('uses the local day shortly before midnight', () => {
    vi.setSystemTime(new Date('2026-11-14T22:30:00Z'))
    expect(localTodayIso()).toBe('2026-11-14')
  })
})

describe('formatSwissDate', () => {
  it('formats ISO as TT.MM.JJJJ', () => {
    expect(formatSwissDate('1978-02-03')).toBe('03.02.1978')
    expect(formatSwissDate('kaputt')).toBe('kaputt')
  })
})

describe('MIN_CALENDAR_YEAR (Review #223)', () => {
  it('accepts dates from 1900 on and rejects earlier ones as typos', () => {
    expect(isValidIsoDateNotAfter('1900-01-01', '2026-11-14')).toBe(true)
    expect(isValidIsoDateNotAfter('1899-12-31', '2026-11-14')).toBe(false)
    expect(isValidIsoDateNotAfter('0026-11-02', '2026-11-14')).toBe(false)
    expect(isBeforeMinYear('0026-11-02')).toBe(true)
    expect(isBeforeMinYear('1900-01-01')).toBe(false)
    expect(isBeforeMinYear('kein Datum')).toBe(false)
    expect(BEFORE_MIN_YEAR_MESSAGE).toBe('Bitte ein Datum ab 1900 eingeben.')
  })
})
