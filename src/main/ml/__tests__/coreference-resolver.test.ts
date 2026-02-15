import { describe, it, expect } from 'vitest'
import { resolveCoreferences, getCanonicalName } from '../coreference-resolver'
import type { MergedEntity } from '../../../shared/types/NerTypes'

function person(text: string, segmentIndex = 0): MergedEntity {
  return {
    text,
    type: 'PERSON',
    source: 'ner',
    segmentIndex,
    charStart: 0,
    charEnd: text.length
  }
}

function location(text: string, segmentIndex = 0): MergedEntity {
  return {
    text,
    type: 'ORT',
    source: 'ner',
    segmentIndex,
    charStart: 0,
    charEnd: text.length
  }
}

describe('getCanonicalName', () => {
  it('strips "Herr" prefix', () => {
    expect(getCanonicalName('Herr Schmidt')).toBe('schmidt')
  })

  it('strips "Frau" prefix', () => {
    expect(getCanonicalName('Frau Müller')).toBe('müller')
  })

  it('strips "Dr." prefix', () => {
    expect(getCanonicalName('Dr. Weber')).toBe('weber')
  })

  it('strips "Prof." prefix', () => {
    expect(getCanonicalName('Prof. Meier')).toBe('meier')
  })

  it('strips combined "Prof. Dr." prefix', () => {
    expect(getCanonicalName('Prof. Dr. Müller')).toBe('müller')
  })

  it('strips "Herr Dr." prefix', () => {
    expect(getCanonicalName('Herr Dr. Fischer')).toBe('fischer')
  })

  it('strips "Hr." and "Fr." prefixes', () => {
    expect(getCanonicalName('Hr. Bauer')).toBe('bauer')
    expect(getCanonicalName('Fr. Lang')).toBe('lang')
  })

  it('lowercases the result', () => {
    expect(getCanonicalName('Peter Schmidt')).toBe('peter schmidt')
  })

  it('handles names without titles', () => {
    expect(getCanonicalName('Müller')).toBe('müller')
  })

  it('trims whitespace', () => {
    expect(getCanonicalName('  Herr   Schmidt  ')).toBe('schmidt')
  })
})

describe('resolveCoreferences', () => {
  it('groups same-name PERSON entities', () => {
    const entities = [person('Müller'), person('Müller', 1)]
    const result = resolveCoreferences(entities)
    const persons = result.filter((e) => e.type === 'PERSON')
    expect(persons).toHaveLength(2)
    expect(persons[0].canonicalText).toBe('Müller')
    expect(persons[1].canonicalText).toBe('Müller')
  })

  it('groups title variants with same surname', () => {
    const entities = [person('Dr. Müller'), person('Herr Müller', 1), person('Müller', 2)]
    const result = resolveCoreferences(entities)
    const persons = result.filter((e) => e.type === 'PERSON')
    expect(persons).toHaveLength(3)
    // All should share the same canonicalText (longest variant)
    const canonicals = new Set(persons.map((p) => p.canonicalText))
    expect(canonicals.size).toBe(1)
    expect(persons[0].canonicalText).toBe('Herr Müller')
  })

  it('groups surname with full name', () => {
    const entities = [person('Peter Schmidt'), person('Schmidt', 1)]
    const result = resolveCoreferences(entities)
    const persons = result.filter((e) => e.type === 'PERSON')
    expect(persons).toHaveLength(2)
    const canonicals = new Set(persons.map((p) => p.canonicalText))
    expect(canonicals.size).toBe(1)
  })

  it('keeps different persons separate', () => {
    const entities = [person('Dr. Müller'), person('Frau Schmidt', 1)]
    const result = resolveCoreferences(entities)
    const persons = result.filter((e) => e.type === 'PERSON')
    expect(persons).toHaveLength(2)
    expect(persons[0].canonicalText).not.toBe(persons[1].canonicalText)
  })

  it('does not touch non-PERSON entities', () => {
    const entities = [person('Müller'), location('Zürich')]
    const result = resolveCoreferences(entities)
    const locations = result.filter((e) => e.type === 'ORT')
    expect(locations).toHaveLength(1)
    expect(locations[0].canonicalText).toBeUndefined()
  })

  it('returns entities unchanged when no PERSON entities', () => {
    const entities = [location('Zürich'), location('Bern')]
    const result = resolveCoreferences(entities)
    expect(result).toHaveLength(2)
    expect(result[0].canonicalText).toBeUndefined()
  })

  it('uses longest variant as canonical representative', () => {
    const entities = [person('Schmidt'), person('Peter Schmidt', 1), person('Dr. Peter Schmidt', 2)]
    const result = resolveCoreferences(entities)
    const persons = result.filter((e) => e.type === 'PERSON')
    // "Dr. Peter Schmidt" is longest
    expect(persons[0].canonicalText).toBe('Dr. Peter Schmidt')
  })
})
