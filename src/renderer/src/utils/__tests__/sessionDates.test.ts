import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  documentDateInfo,
  documentDateLabel,
  importDayIso,
  validateDocumentDate
} from '../sessionDates'
import { groupTimelineByMonth } from '../groupTimelineByMonth'
import { makeTimelineEntry } from '../../test/dossierFixtures'

let previousTz: string | undefined
beforeAll(() => {
  previousTz = process.env.TZ
  process.env.TZ = 'Europe/Zurich'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

describe('document date (#205 AK 19/20)', () => {
  it('uses the local import day while no document date is set', () => {
    // 00:30 lokal am 14.11. — in UTC noch der 13.
    const pdf = { createdAt: '2026-11-13T23:30:00.000Z', documentDate: null }
    expect(importDayIso(pdf.createdAt)).toBe('2026-11-14')
    expect(documentDateLabel(pdf)).toBe('14.11.2026 · Importdatum')
    expect(documentDateInfo(pdf)).toEqual({
      date: '14.11.2026',
      isSet: false,
      importDate: '14.11.2026'
    })
  })

  it('shows a set document date without the import marker', () => {
    const pdf = { createdAt: '2026-11-13T09:00:00.000Z', documentDate: '2026-11-02' }
    expect(documentDateLabel(pdf)).toBe('02.11.2026')
    expect(documentDateInfo(pdf).isSet).toBe(true)
  })
})

describe('validateDocumentDate (#205 AK 21)', () => {
  const today = '2026-11-14'

  it('accepts complete, valid dates up to today', () => {
    expect(validateDocumentDate('14.11.2026', today)).toEqual({ iso: '2026-11-14' })
    expect(validateDocumentDate('2.1.2025', today)).toEqual({ iso: '2025-01-02' })
    expect(validateDocumentDate('29.02.2024', today)).toEqual({ iso: '2024-02-29' })
  })

  it('rejects empty, incomplete and impossible dates', () => {
    expect(validateDocumentDate('', today)).toHaveProperty('error')
    expect(validateDocumentDate('11.2026', today)).toHaveProperty('error')
    expect(validateDocumentDate('31.04.2026', today)).toHaveProperty('error')
    expect(validateDocumentDate('29.02.2025', today)).toHaveProperty('error')
    expect(validateDocumentDate('2026-11-01', today)).toHaveProperty('error')
  })

  it('rejects years before 1900 (Review #223)', () => {
    expect(validateDocumentDate('02.11.0026', today)).toEqual({
      error: 'Bitte ein Datum ab 1900 eingeben.'
    })
    expect(validateDocumentDate('31.12.1899', today)).toHaveProperty('error')
    expect(validateDocumentDate('01.01.1900', today)).toEqual({ iso: '1900-01-01' })
  })

  it('rejects a date after today', () => {
    expect(validateDocumentDate('15.11.2026', today)).toEqual({
      error: 'Das Dokumentdatum darf nicht nach dem heutigen Tag liegen.'
    })
  })
})

describe('groupTimelineByMonth', () => {
  it('groups consecutive entries by the month of sortDay, keeping the order', () => {
    const entries = [
      makeTimelineEntry({ id: 'a', sortDay: '2026-11-14' }),
      makeTimelineEntry({ id: 'b', sortDay: '2026-11-01' }),
      makeTimelineEntry({ id: 'c', sortDay: '2026-10-31' }),
      makeTimelineEntry({ id: 'd', sortDay: '2025-12-24' })
    ]
    const months = groupTimelineByMonth(entries)
    expect(months.map((m) => [m.label, m.entries.map((e) => e.id)])).toEqual([
      ['November 2026', ['a', 'b']],
      ['Oktober 2026', ['c']],
      ['Dezember 2025', ['d']]
    ])
  })

  it('labels years below 100 correctly instead of as 19xx', () => {
    const months = groupTimelineByMonth([makeTimelineEntry({ sortDay: '0026-11-02' })])
    expect(months[0].label).toMatch(/26$/)
    expect(months[0].label).not.toContain('1926')
  })

  it('returns no month for an empty timeline', () => {
    expect(groupTimelineByMonth([])).toEqual([])
  })
})
