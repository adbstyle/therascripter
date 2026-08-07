import { describe, it, expect } from 'vitest'
import { formatHms, formatSilenceWithShare, formatPercentDeCh } from '../formatAudioStats'

describe('formatHms', () => {
  it('renders seconds-only when under a minute', () => {
    expect(formatHms(0)).toBe('0s')
    expect(formatHms(10)).toBe('10s')
    expect(formatHms(59)).toBe('59s')
  })

  it('renders minutes and seconds', () => {
    expect(formatHms(60)).toBe('1m 0s')
    expect(formatHms(533)).toBe('8m 53s')
    expect(formatHms(3599)).toBe('59m 59s')
  })

  it('renders hours, minutes and seconds', () => {
    expect(formatHms(3600)).toBe('1h 0m 0s')
    expect(formatHms(3725)).toBe('1h 2m 5s')
  })

  it('floors fractional seconds', () => {
    expect(formatHms(533.7)).toBe('8m 53s')
  })

  it('clamps negative values to zero', () => {
    expect(formatHms(-3)).toBe('0s')
  })
})

describe('formatSilenceWithShare', () => {
  it('appends a percentage share of the original', () => {
    expect(formatSilenceWithShare(11, 533)).toBe('11s · 2.1 %')
  })

  it('omits the percent share when original duration is zero', () => {
    expect(formatSilenceWithShare(0, 0)).toBe('0s')
  })

  it('renders 100 percent when stitched is zero (AC9)', () => {
    expect(formatSilenceWithShare(120, 120)).toBe('2m 0s · 100.0 %')
  })
})

describe('formatPercentDeCh', () => {
  it('rounds to one decimal place with period as decimal separator', () => {
    expect(formatPercentDeCh(23.45)).toBe('23.5 %')
    expect(formatPercentDeCh(100)).toBe('100.0 %')
    expect(formatPercentDeCh(0)).toBe('0.0 %')
  })

  it('handles non-finite values defensively', () => {
    expect(formatPercentDeCh(Number.NaN)).toBe('0.0 %')
  })
})
