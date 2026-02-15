import { describe, it, expect } from 'vitest'
import { buildEntityMap, findEntityId } from '../entity-map-builder'
import type { MergedEntity } from '../../../shared/types/NerTypes'

function entity(
  text: string,
  type: MergedEntity['type'],
  segmentIndex = 0,
  canonicalText?: string
): MergedEntity {
  return {
    text,
    type,
    source: 'ner',
    segmentIndex,
    charStart: 0,
    charEnd: text.length,
    canonicalText
  }
}

describe('buildEntityMap', () => {
  it('creates entries for each unique entity', () => {
    const entities = [entity('Müller', 'PERSON'), entity('Zürich', 'ORT')]
    const map = buildEntityMap(entities)
    expect(Object.keys(map)).toHaveLength(2)
    expect(map['person-1']).toBeDefined()
    expect(map['ort-1']).toBeDefined()
  })

  it('assigns correct placeholders', () => {
    const entities = [entity('Müller', 'PERSON'), entity('Zürich', 'ORT')]
    const map = buildEntityMap(entities)
    expect(map['person-1'].placeholder).toBe('[PERSON 1]')
    expect(map['ort-1'].placeholder).toBe('[ORT 1]')
  })

  it('increments counters per type', () => {
    const entities = [
      entity('Müller', 'PERSON'),
      entity('Schmidt', 'PERSON', 1),
      entity('Zürich', 'ORT')
    ]
    const map = buildEntityMap(entities)
    expect(map['person-1'].placeholder).toBe('[PERSON 1]')
    expect(map['person-2'].placeholder).toBe('[PERSON 2]')
    expect(map['ort-1'].placeholder).toBe('[ORT 1]')
  })

  it('deduplicates via canonicalText (coreference groups)', () => {
    const entities = [
      entity('Dr. Müller', 'PERSON', 0, 'Dr. Müller'),
      entity('Müller', 'PERSON', 1, 'Dr. Müller')
    ]
    const map = buildEntityMap(entities)
    // Both share "Dr. Müller" as canonical → only one entry
    expect(Object.keys(map)).toHaveLength(1)
    expect(map['person-1'].original).toBe('Dr. Müller')
  })

  it('preserves source from first occurrence', () => {
    const entities: MergedEntity[] = [
      {
        text: 'Zürich',
        type: 'ORT',
        source: 'blocklist',
        segmentIndex: 0,
        charStart: 0,
        charEnd: 6
      }
    ]
    const map = buildEntityMap(entities)
    expect(map['ort-1'].source).toBe('blocklist')
  })

  it('returns empty map for empty entities', () => {
    const map = buildEntityMap([])
    expect(Object.keys(map)).toHaveLength(0)
  })
})

describe('findEntityId', () => {
  it('finds entity by text and type', () => {
    const entities = [entity('Müller', 'PERSON')]
    const map = buildEntityMap(entities)
    const id = findEntityId(map, 'Müller', 'PERSON', entities)
    expect(id).toBe('person-1')
  })

  it('finds entity via canonical text (coreference)', () => {
    const entities = [
      entity('Dr. Müller', 'PERSON', 0, 'Dr. Müller'),
      entity('Müller', 'PERSON', 1, 'Dr. Müller')
    ]
    const map = buildEntityMap(entities)
    const id = findEntityId(map, 'Müller', 'PERSON', entities)
    expect(id).toBe('person-1')
  })

  it('returns null for unknown entity', () => {
    const entities = [entity('Müller', 'PERSON')]
    const map = buildEntityMap(entities)
    const id = findEntityId(map, 'Schmidt', 'PERSON', entities)
    expect(id).toBeNull()
  })

  it('returns null for wrong type', () => {
    const entities = [entity('Müller', 'PERSON')]
    const map = buildEntityMap(entities)
    const id = findEntityId(map, 'Müller', 'ORT', entities)
    expect(id).toBeNull()
  })

  it('is case-insensitive', () => {
    const entities = [entity('Müller', 'PERSON')]
    const map = buildEntityMap(entities)
    const id = findEntityId(map, 'müller', 'PERSON', entities)
    expect(id).toBe('person-1')
  })
})
