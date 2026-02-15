import { describe, it, expect } from 'vitest'
import { runRegexEngine, mapRegexTypeToPlaceholder } from '../regex-patterns'
import type { TranscriptSegment } from '../../../shared/types'

function seg(text: string): TranscriptSegment {
  return { text, start: 0, end: 1, speaker: 'Person A' }
}

describe('runRegexEngine', () => {
  it('detects Swiss phone numbers', () => {
    const segments = [seg('+41 79 123 45 67 ist meine Nummer')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('+41 79 123 45 67')
    expect(entities[0].regexType).toBe('TELEFON')
    expect(entities[0].charStart).toBe(0)
    expect(entities[0].charEnd).toBe(16)
  })

  it('detects Swiss landline numbers without +41', () => {
    const segments = [seg('Rufen Sie 044 123 45 67 an')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('044 123 45 67')
    expect(entities[0].regexType).toBe('TELEFON')
  })

  it('detects international phone numbers', () => {
    const segments = [seg('Kontakt: +49 30 12345678')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('+49 30 12345678')
    expect(entities[0].regexType).toBe('TELEFON')
  })

  it('detects AHV numbers', () => {
    const segments = [seg('AHV-Nr: 756.1234.5678.97')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('756.1234.5678.97')
    expect(entities[0].regexType).toBe('AHV')
  })

  it('detects email addresses', () => {
    const segments = [seg('E-Mail an test.user@example.com senden')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('test.user@example.com')
    expect(entities[0].regexType).toBe('EMAIL')
  })

  it('detects PLZ + Ort', () => {
    const segments = [seg('Wohnhaft in 8001 Zürich')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('8001 Zürich')
    expect(entities[0].regexType).toBe('PLZ_ORT')
  })

  it('detects Geburtsdatum with context', () => {
    const segments = [seg('Patient geb. 15.03.1985')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('geb. 15.03.1985')
    expect(entities[0].regexType).toBe('GEBURTSDATUM')
  })

  it('detects standalone dates', () => {
    const segments = [seg('Am 23.12.2024 war der Termin')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('23.12.2024')
    expect(entities[0].regexType).toBe('DATUM_STANDALONE')
  })

  it('detects Swiss insurance numbers', () => {
    const segments = [seg('Versicherung 80756.01.00012345.67')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].text).toBe('80756.01.00012345.67')
    expect(entities[0].regexType).toBe('VERSICHERUNG')
  })

  it('detects case numbers (Fall-Nr)', () => {
    const segments = [seg('Fall-Nr. 2024-A7 ist zugewiesen')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(1)
    expect(entities[0].regexType).toBe('FALL_NR')
  })

  it('detects street addresses', () => {
    const segments = [seg('Adresse Bahnhofstrasse 42 in Zürich')]
    const entities = runRegexEngine(segments)
    const streets = entities.filter((e) => e.regexType === 'STRASSE')
    expect(streets).toHaveLength(1)
    expect(streets[0].text).toBe('Bahnhofstrasse 42')
  })

  it('handles multiple entities in one segment', () => {
    const segments = [seg('Tel +41 79 123 45 67 Email test@example.com')]
    const entities = runRegexEngine(segments)
    expect(entities.length).toBeGreaterThanOrEqual(2)
    const types = entities.map((e) => e.regexType)
    expect(types).toContain('TELEFON')
    expect(types).toContain('EMAIL')
  })

  it('handles multiple segments', () => {
    const segments = [seg('Nummer: +41 79 111 22 33'), seg('Email: foo@bar.ch')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(2)
    expect(entities[0].segmentIndex).toBe(0)
    expect(entities[1].segmentIndex).toBe(1)
  })

  it('returns empty array for no matches', () => {
    const segments = [seg('Das ist ein normaler Satz ohne PII')]
    const entities = runRegexEngine(segments)
    expect(entities).toHaveLength(0)
  })

  it('deduplicates overlapping matches', () => {
    // "geb. 15.03.1985" matches both GEBURTSDATUM and DATE_FULL
    // GEBURTSDATUM appears first in ALL_PATTERNS → kept, DATE_FULL → dropped
    const segments = [seg('Patient geb. 15.03.1985 wurde behandelt')]
    const entities = runRegexEngine(segments)
    const dateEntities = entities.filter(
      (e) => e.regexType === 'GEBURTSDATUM' || e.regexType === 'DATUM_STANDALONE'
    )
    // Should not have overlapping date matches
    expect(dateEntities).toHaveLength(1)
  })
})

describe('mapRegexTypeToPlaceholder', () => {
  it('maps TELEFON to KONTAKT', () => {
    expect(mapRegexTypeToPlaceholder('TELEFON')).toBe('KONTAKT')
  })

  it('maps EMAIL to KONTAKT', () => {
    expect(mapRegexTypeToPlaceholder('EMAIL')).toBe('KONTAKT')
  })

  it('maps AHV to KONTAKT', () => {
    expect(mapRegexTypeToPlaceholder('AHV')).toBe('KONTAKT')
  })

  it('maps PLZ_ORT to ORT', () => {
    expect(mapRegexTypeToPlaceholder('PLZ_ORT')).toBe('ORT')
  })

  it('maps GEBURTSDATUM to DATUM', () => {
    expect(mapRegexTypeToPlaceholder('GEBURTSDATUM')).toBe('DATUM')
  })

  it('maps DATUM_STANDALONE to DATUM', () => {
    expect(mapRegexTypeToPlaceholder('DATUM_STANDALONE')).toBe('DATUM')
  })

  it('maps unknown types to KONTAKT', () => {
    expect(mapRegexTypeToPlaceholder('UNKNOWN')).toBe('KONTAKT')
  })
})
