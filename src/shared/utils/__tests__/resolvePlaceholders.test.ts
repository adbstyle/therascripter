import { describe, it, expect } from 'vitest'
import {
  buildPlaceholderSnapshot,
  parsePlaceholderSnapshot,
  resolvePlaceholders,
  uniqueOriginalsByToken
} from '../resolvePlaceholders'
import type { EntityMap, PlaceholderType } from '../../types'

function entry(placeholder: string, original: string, type: PlaceholderType = 'PERSON') {
  return { placeholder, original, type, source: 'ner' as const }
}

const MAP: EntityMap = {
  'person-1': entry('[PERSON 1]', 'Ruth Gerber'),
  'ort-1': entry('[ORT 1]', 'Bern', 'ORT'),
  'datum-1': entry('[DATUM 1]', '3. März', 'DATUM'),
  'kontakt-1': entry('[KONTAKT 1]', '079 123 45 67', 'KONTAKT'),
  'organisation-1': entry('[ORGANISATION 1]', 'Spital Tiefenau', 'ORGANISATION'),
  'medizinisch-1': entry('[MEDIZINISCH 1]', 'Sertralin', 'MEDIZINISCH'),
  'sonstiges-1': entry('[SONSTIGES 1]', 'AHV 756.1234', 'SONSTIGES')
}

describe('resolvePlaceholders', () => {
  it('replaces tokens of every type whose meaning is unchanged (AK 4)', () => {
    const text =
      '[PERSON 1] aus [ORT 1] kam am [DATUM 1] ([KONTAKT 1]) vom [ORGANISATION 1] mit [MEDIZINISCH 1], [SONSTIGES 1].'
    const snapshot = buildPlaceholderSnapshot(text, MAP)
    expect(resolvePlaceholders(text, MAP, snapshot)).toBe(
      'Ruth Gerber aus Bern kam am 3. März (079 123 45 67) vom Spital Tiefenau mit Sertralin, AHV 756.1234.'
    )
  })

  it('keeps a token whose number was handed to another original since (AK 5)', () => {
    const text = 'Gespräch mit [PERSON 1].'
    const snapshot = buildPlaceholderSnapshot(text, MAP)
    // «Platzhalter entfernen» freed the number, a new pseudonymization reused it
    const later: EntityMap = { ...MAP, 'person-1': entry('[PERSON 1]', 'Max Muster') }
    expect(resolvePlaceholders(text, later, snapshot)).toBe('Gespräch mit [PERSON 1].')
  })

  it('keeps a token whose entity changed type and number since (AK 5)', () => {
    const text = 'Gespräch in [ORT 1].'
    const snapshot = buildPlaceholderSnapshot(text, MAP)
    const later: EntityMap = { ...MAP }
    delete later['ort-1']
    later['organisation-2'] = entry('[ORGANISATION 2]', 'Bern', 'ORGANISATION')
    expect(resolvePlaceholders(text, later, snapshot)).toBe('Gespräch in [ORT 1].')
  })

  it('keeps tokens without a recorded meaning (legacy text without snapshot)', () => {
    expect(resolvePlaceholders('[PERSON 1] kam.', MAP, null)).toBe('[PERSON 1] kam.')
  })

  it('keeps tokens the EntityMap does not resolve unambiguously', () => {
    const ambiguous: EntityMap = {
      a: entry('[PERSON 1]', 'Ruth Gerber'),
      b: entry('[PERSON 1]', 'Max Muster')
    }
    expect(uniqueOriginalsByToken(ambiguous).has('[PERSON 1]')).toBe(false)
    expect(buildPlaceholderSnapshot('[PERSON 1]', ambiguous)).toBeNull()
    expect(resolvePlaceholders('[PERSON 1]', ambiguous, { '[PERSON 1]': 'Ruth Gerber' })).toBe(
      '[PERSON 1]'
    )
  })

  it('keeps tokens without an original (AK 6)', () => {
    const noOriginal: EntityMap = { 'person-1': entry('[PERSON 1]', '  ') }
    expect(buildPlaceholderSnapshot('[PERSON 1]', noOriginal)).toBeNull()
    expect(resolvePlaceholders('[PERSON 1]', noOriginal, { '[PERSON 1]': '  ' })).toBe('[PERSON 1]')
  })

  it('leaves text that only looks like a token alone', () => {
    const text = '[Person 1] und [PERSON] und [1] bleiben.'
    expect(resolvePlaceholders(text, MAP, { '[PERSON 1]': 'Ruth Gerber' })).toBe(text)
  })

  it('tolerates a missing or broken EntityMap', () => {
    expect(resolvePlaceholders('[PERSON 1]', null, { '[PERSON 1]': 'Ruth Gerber' })).toBe(
      '[PERSON 1]'
    )
    expect(
      resolvePlaceholders('[PERSON 1]', { x: null } as unknown as EntityMap, {
        '[PERSON 1]': 'Ruth'
      })
    ).toBe('[PERSON 1]')
  })
})

describe('buildPlaceholderSnapshot', () => {
  it('records only tokens that occur in the text', () => {
    expect(buildPlaceholderSnapshot('[PERSON 1] in Bern', MAP)).toEqual({
      '[PERSON 1]': 'Ruth Gerber'
    })
    expect(buildPlaceholderSnapshot('ohne Platzhalter', MAP)).toBeNull()
    expect(buildPlaceholderSnapshot(null, MAP)).toBeNull()
  })

  it('keeps the recorded meaning of tokens already present after an edit', () => {
    const previous = { '[PERSON 1]': 'Ruth Gerber' }
    const later: EntityMap = {
      'person-1': entry('[PERSON 1]', 'Max Muster'),
      'ort-1': entry('[ORT 1]', 'Thun', 'ORT')
    }
    // The user edited the summary and typed a new token
    const edited = buildPlaceholderSnapshot('[PERSON 1] zog nach [ORT 1].', later, previous)
    expect(edited).toEqual({ '[PERSON 1]': 'Ruth Gerber', '[ORT 1]': 'Thun' })
    expect(resolvePlaceholders('[PERSON 1] zog nach [ORT 1].', later, edited)).toBe(
      '[PERSON 1] zog nach Thun.'
    )
  })

  it('drops tokens that left the text', () => {
    expect(buildPlaceholderSnapshot('nur noch Text', MAP, { '[PERSON 1]': 'Ruth' })).toBeNull()
  })
})

describe('parsePlaceholderSnapshot', () => {
  it('parses a string map and rejects everything else', () => {
    expect(parsePlaceholderSnapshot('{"[PERSON 1]":"Ruth"}')).toEqual({ '[PERSON 1]': 'Ruth' })
    expect(parsePlaceholderSnapshot('{"[PERSON 1]":3}')).toEqual({})
    expect(parsePlaceholderSnapshot('[1]')).toBeNull()
    expect(parsePlaceholderSnapshot('kaputt')).toBeNull()
    expect(parsePlaceholderSnapshot(null)).toBeNull()
  })
})
