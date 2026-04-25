import { describe, it, expect, vi } from 'vitest'
import {
  mergeEntities,
  normalizeUmlaut,
  isWholeWord,
  mapFlairType,
  mapNativeType
} from '../entity-merger'
import type { TranscriptSegment } from '../../../shared/types'
import type { NerEntity, RegexEntity, BlocklistEntry } from '../../../shared/types/NerTypes'

function seg(text: string): TranscriptSegment {
  return { text, start: 0, end: 1, speaker: 'Person A' }
}

describe('normalizeUmlaut', () => {
  it('normalizes ä to ae', () => {
    expect(normalizeUmlaut('Bär')).toBe('Baer')
  })

  it('normalizes ö to oe', () => {
    expect(normalizeUmlaut('schön')).toBe('schoen')
  })

  it('normalizes ü to ue', () => {
    expect(normalizeUmlaut('Zürich')).toBe('Zuerich')
  })

  it('normalizes ß to ss', () => {
    expect(normalizeUmlaut('Straße')).toBe('Strasse')
  })

  it('normalizes multiple umlauts (lowercase input)', () => {
    expect(normalizeUmlaut('müller-öttinger')).toBe('mueller-oettinger')
  })

  it('leaves text without umlauts unchanged', () => {
    expect(normalizeUmlaut('Hello World')).toBe('Hello World')
  })
})

describe('isWholeWord', () => {
  it('matches word at start of string', () => {
    expect(isWholeWord('Müller ist hier', 0, 6)).toBe(true)
  })

  it('matches word at end of string', () => {
    expect(isWholeWord('Das ist Müller', 8, 14)).toBe(true)
  })

  it('matches word in middle with spaces', () => {
    expect(isWholeWord('Ich bin Müller und du', 8, 14)).toBe(true)
  })

  it('rejects partial word match at start', () => {
    // "Müller" inside "Müllerstrasse"
    expect(isWholeWord('Müllerstrasse 5', 0, 6)).toBe(false)
  })

  it('rejects partial word match at end', () => {
    expect(isWholeWord('der Obermüller', 8, 14)).toBe(false)
  })

  it('matches word after punctuation', () => {
    expect(isWholeWord('Hallo, Müller!', 7, 13)).toBe(true)
  })

  it('matches word before punctuation', () => {
    expect(isWholeWord('Müller, bitte', 0, 6)).toBe(true)
  })
})

describe('mergeEntities', () => {
  const segments = [seg('Dr. Müller wohnt in Zürich seit 15.03.1985')]

  it('includes NER PER entities', () => {
    const nerEntities: NerEntity[] = [
      {
        text: 'Dr. Müller',
        type: 'PER',
        segmentIndex: 0,
        charStart: 0,
        charEnd: 10,
        confidence: 0.95
      }
    ]
    const result = mergeEntities(nerEntities, [], [], segments)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Dr. Müller')
    expect(result[0].type).toBe('PERSON')
    expect(result[0].source).toBe('ner')
  })

  it('includes NER LOC entities', () => {
    const nerEntities: NerEntity[] = [
      { text: 'Zürich', type: 'LOC', segmentIndex: 0, charStart: 20, charEnd: 26, confidence: 0.9 }
    ]
    const result = mergeEntities(nerEntities, [], [], segments)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('ORT')
  })

  it('includes NER MISC entities as SONSTIGES', () => {
    const nerEntities: NerEntity[] = [
      { text: 'test', type: 'MISC', segmentIndex: 0, charStart: 0, charEnd: 4, confidence: 0.8 }
    ]
    const testSegments = [seg('test entity here')]
    const result = mergeEntities(nerEntities, [], [], testSegments)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('SONSTIGES')
  })

  it('ignores NER ORG entities (Decision #5/#158)', () => {
    const nerEntities: NerEntity[] = [
      {
        text: 'Universität',
        type: 'ORG',
        segmentIndex: 0,
        charStart: 0,
        charEnd: 11,
        confidence: 0.9
      }
    ]
    const testSegments = [seg('Universität Bern ist gut')]
    const result = mergeEntities(nerEntities, [], [], testSegments)
    expect(result).toHaveLength(0)
  })

  it('merges regex entities when no NER overlap', () => {
    const regexEntities: RegexEntity[] = [
      {
        text: '15.03.1985',
        regexType: 'DATUM_STANDALONE',
        segmentIndex: 0,
        charStart: 32,
        charEnd: 42
      }
    ]
    const result = mergeEntities([], regexEntities, [], segments)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('DATUM')
  })

  it('merges blocklist entries', () => {
    const blocklistEntries: BlocklistEntry[] = [
      { id: '1', term: 'Zürich', placeholderType: 'ORT', createdAt: '' }
    ]
    const result = mergeEntities([], [], blocklistEntries, segments)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Zürich')
    expect(result[0].source).toBe('blocklist')
  })

  it('NER takes priority over blocklist (no overlap)', () => {
    const nerEntities: NerEntity[] = [
      { text: 'Zürich', type: 'LOC', segmentIndex: 0, charStart: 20, charEnd: 26, confidence: 0.9 }
    ]
    const blocklistEntries: BlocklistEntry[] = [
      { id: '1', term: 'Zürich', placeholderType: 'ORT', createdAt: '' }
    ]
    const result = mergeEntities(nerEntities, [], blocklistEntries, segments)
    // NER added first; blocklist overlaps → skipped
    const zurichEntities = result.filter((e) => e.text === 'Zürich')
    expect(zurichEntities).toHaveLength(1)
    expect(zurichEntities[0].source).toBe('ner')
  })

  it('blocklist uses longest-match-first', () => {
    const testSegments = [seg('Peter Schmidt ist hier')]
    const blocklistEntries: BlocklistEntry[] = [
      { id: '1', term: 'Schmidt', placeholderType: 'PERSON', createdAt: '' },
      { id: '2', term: 'Peter Schmidt', placeholderType: 'PERSON', createdAt: '' }
    ]
    const result = mergeEntities([], [], blocklistEntries, testSegments)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('Peter Schmidt')
  })

  it('regex entities are skipped when they overlap with NER', () => {
    const nerEntities: NerEntity[] = [
      { text: 'Zürich', type: 'LOC', segmentIndex: 0, charStart: 20, charEnd: 26, confidence: 0.9 }
    ]
    const regexEntities: RegexEntity[] = [
      { text: 'Zürich', regexType: 'PLZ_ORT', segmentIndex: 0, charStart: 20, charEnd: 26 }
    ]
    const result = mergeEntities(nerEntities, regexEntities, [], segments)
    const zurichEntities = result.filter((e) => e.text.includes('Zürich'))
    expect(zurichEntities).toHaveLength(1)
    expect(zurichEntities[0].source).toBe('ner')
  })

  it('results are sorted by segment index then position', () => {
    const testSegments = [seg('Peter in Bern'), seg('Anna in Zürich')]
    const nerEntities: NerEntity[] = [
      { text: 'Bern', type: 'LOC', segmentIndex: 0, charStart: 9, charEnd: 13, confidence: 0.9 },
      { text: 'Peter', type: 'PER', segmentIndex: 0, charStart: 0, charEnd: 5, confidence: 0.9 },
      { text: 'Anna', type: 'PER', segmentIndex: 1, charStart: 0, charEnd: 4, confidence: 0.9 }
    ]
    const result = mergeEntities(nerEntities, [], [], testSegments)
    expect(result[0].text).toBe('Peter')
    expect(result[1].text).toBe('Bern')
    expect(result[2].text).toBe('Anna')
  })
})

describe('mapFlairType', () => {
  it('maps PER to PERSON', () => {
    expect(mapFlairType('PER')).toBe('PERSON')
  })

  it('maps LOC to ORT', () => {
    expect(mapFlairType('LOC')).toBe('ORT')
  })

  it('maps MISC to SONSTIGES', () => {
    expect(mapFlairType('MISC')).toBe('SONSTIGES')
  })

  it('drops ORG (Decision #5/#158)', () => {
    expect(mapFlairType('ORG')).toBeNull()
  })

  it('drops unknown types', () => {
    expect(mapFlairType('UNKNOWN_TYPE')).toBeNull()
  })
})

describe('mapNativeType (backend dispatcher)', () => {
  it('flair backend delegates to mapFlairType', () => {
    expect(mapNativeType('flair', 'PER')).toBe('PERSON')
    expect(mapNativeType('flair', 'LOC')).toBe('ORT')
    expect(mapNativeType('flair', 'ORG')).toBeNull()
  })

  it('gliner backend drops everything until mapper is wired (Phase 2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapNativeType('gliner', 'Person')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ai4privacy backend drops everything until mapper is wired (Phase 2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(mapNativeType('ai4privacy', 'GIVENNAME')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('mergeEntities backend dispatch', () => {
  it('uses flair mapping by default when no backend is passed', () => {
    const segments = [seg('Peter wohnt in Bern')]
    const nerEntities: NerEntity[] = [
      { text: 'Peter', type: 'PER', segmentIndex: 0, charStart: 0, charEnd: 5, confidence: 0.9 }
    ]
    const result = mergeEntities(nerEntities, [], [], segments)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('PERSON')
  })

  it('explicit flair backend gives identical result to default', () => {
    const segments = [seg('Peter wohnt in Bern')]
    const nerEntities: NerEntity[] = [
      { text: 'Peter', type: 'PER', segmentIndex: 0, charStart: 0, charEnd: 5, confidence: 0.9 }
    ]
    const result = mergeEntities(nerEntities, [], [], segments, 'flair')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('PERSON')
  })

  it('gliner backend drops all entities until Phase 2 wires its mapper', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const segments = [seg('Peter wohnt in Bern')]
    const nerEntities: NerEntity[] = [
      { text: 'Peter', type: 'Person', segmentIndex: 0, charStart: 0, charEnd: 5, confidence: 0.9 }
    ]
    const result = mergeEntities(nerEntities, [], [], segments, 'gliner')
    expect(result).toHaveLength(0)
    warn.mockRestore()
  })
})
