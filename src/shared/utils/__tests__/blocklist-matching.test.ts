import { describe, it, expect } from 'vitest'
import {
  normalizeUmlaut,
  isWholeWord,
  normalizeWithPositionMap
} from '../blocklist-matching'

describe('normalizeUmlaut', () => {
  it('normalizes all German special characters', () => {
    expect(normalizeUmlaut('Müller')).toBe('Mueller')
    expect(normalizeUmlaut('schön')).toBe('schoen')
    expect(normalizeUmlaut('Bär')).toBe('Baer')
    expect(normalizeUmlaut('Straße')).toBe('Strasse')
  })

  it('normalizes multiple umlauts in one string', () => {
    expect(normalizeUmlaut('müller-öttinger')).toBe('mueller-oettinger')
  })

  it('returns unchanged text without umlauts', () => {
    expect(normalizeUmlaut('Hello World')).toBe('Hello World')
    expect(normalizeUmlaut('')).toBe('')
  })
})

describe('isWholeWord', () => {
  it('matches word at start of string', () => {
    expect(isWholeWord('Müller ist hier', 0, 6)).toBe(true)
  })

  it('matches word at end of string', () => {
    expect(isWholeWord('Das ist Müller', 8, 14)).toBe(true)
  })

  it('matches word surrounded by spaces', () => {
    expect(isWholeWord('Er heisst Müller und', 10, 16)).toBe(true)
  })

  it('matches word surrounded by punctuation', () => {
    expect(isWholeWord('Hallo, Müller!', 7, 13)).toBe(true)
  })

  it('rejects partial match inside a word', () => {
    expect(isWholeWord('Müllerstrasse', 0, 6)).toBe(false)
  })

  it('matches single word (entire string)', () => {
    expect(isWholeWord('Müller', 0, 6)).toBe(true)
  })
})

describe('normalizeWithPositionMap', () => {
  it('returns identity mapping for text without umlauts', () => {
    const result = normalizeWithPositionMap('hello')
    expect(result.normalized).toBe('hello')
    expect(result.toOriginal).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('maps ü to ue with correct position mapping', () => {
    const result = normalizeWithPositionMap('müller')
    expect(result.normalized).toBe('mueller')
    // m=0, u(ü)=1, e(ü)=1, l=2, l=3, e=4, r=5, sentinel=6
    expect(result.toOriginal).toEqual([0, 1, 1, 2, 3, 4, 5, 6])
  })

  it('maps ß to ss with correct position mapping', () => {
    const result = normalizeWithPositionMap('straße')
    expect(result.normalized).toBe('strasse')
    // s=0, t=1, r=2, a=3, s(ß)=4, s(ß)=4, e=5, sentinel=6
    expect(result.toOriginal).toEqual([0, 1, 2, 3, 4, 4, 5, 6])
  })

  it('handles multiple umlauts', () => {
    const result = normalizeWithPositionMap('für dü')
    expect(result.normalized).toBe('fuer due')
    // f=0, u(ü)=1, e(ü)=1, r=2, ' '=3, d=4, u(ü)=5, e(ü)=5, sentinel=6
    expect(result.toOriginal).toEqual([0, 1, 1, 2, 3, 4, 5, 5, 6])
  })

  it('handles empty string', () => {
    const result = normalizeWithPositionMap('')
    expect(result.normalized).toBe('')
    expect(result.toOriginal).toEqual([0])
  })

  it('position mapping allows correct substring extraction', () => {
    // Simulate finding "mueller" in "dr. müller aus zürich"
    const text = 'dr. müller aus zürich'
    const { normalized, toOriginal } = normalizeWithPositionMap(text.toLowerCase())

    // Find "mueller" in normalized
    const searchTerm = normalizeUmlaut('müller')
    const idx = normalized.indexOf(searchTerm)
    expect(idx).toBeGreaterThan(-1)

    // Map back to original positions
    const origStart = toOriginal[idx]
    const origEnd = toOriginal[idx + searchTerm.length]
    expect(text.substring(origStart, origEnd)).toBe('müller')
  })

  it('position mapping works for ß -> ss search', () => {
    const text = 'die Straße hier'
    const { normalized, toOriginal } = normalizeWithPositionMap(text.toLowerCase())

    const searchTerm = normalizeUmlaut('straße')
    const idx = normalized.indexOf(searchTerm)
    expect(idx).toBeGreaterThan(-1)

    const origStart = toOriginal[idx]
    const origEnd = toOriginal[idx + searchTerm.length]
    expect(text.substring(origStart, origEnd)).toBe('Straße')
  })
})
