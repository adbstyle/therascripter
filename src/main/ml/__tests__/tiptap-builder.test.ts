import { describe, it, expect } from 'vitest'
import { buildTipTapDocument } from '../tiptap-builder'
import { buildEntityMap } from '../entity-map-builder'
import type { TranscriptSegment } from '../../../shared/types'
import type { MergedEntity } from '../../../shared/types/NerTypes'
import type {
  TipTapTextNode,
  TipTapPlaceholderChip,
  TipTapSpeakerLabel,
  TipTapTimestamp
} from '../../../shared/types/TipTapDocument'

function seg(text: string, speaker: string, start = 0, end = 1): TranscriptSegment {
  return { text, start, end, speaker }
}

function entity(
  text: string,
  type: MergedEntity['type'],
  segmentIndex: number,
  charStart: number,
  charEnd: number,
  canonicalText?: string
): MergedEntity {
  return {
    text,
    type,
    source: 'ner',
    segmentIndex,
    charStart,
    charEnd,
    canonicalText
  }
}

describe('buildTipTapDocument', () => {
  it('returns a doc with paragraphs', () => {
    const segments = [seg('Hallo Welt', 'Person A')]
    const doc = buildTipTapDocument(segments, {}, [], 1)
    expect(doc.type).toBe('doc')
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].type).toBe('paragraph')
  })

  it('creates text-only nodes when no entities', () => {
    const segments = [seg('Das ist ein Satz.', 'Person A')]
    const doc = buildTipTapDocument(segments, {}, [], 1)
    const content = doc.content[0].content
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    expect((content[0] as TipTapTextNode).text).toBe('Das ist ein Satz.')
  })

  it('replaces entity spans with placeholderChip nodes', () => {
    const segments = [seg('Dr. Müller wohnt hier', 'Person A')]
    const entities: MergedEntity[] = [entity('Dr. Müller', 'PERSON', 0, 0, 10, 'Dr. Müller')]
    const entityMap = buildEntityMap(entities)
    const doc = buildTipTapDocument(segments, entityMap, entities, 1)

    const content = doc.content[0].content
    const chips = content.filter((n) => n.type === 'placeholderChip') as TipTapPlaceholderChip[]
    expect(chips).toHaveLength(1)
    expect(chips[0].attrs.entityId).toBe('person-1')
    expect(chips[0].attrs.type).toBe('PERSON')
    expect(chips[0].attrs.number).toBe(1)
    expect(chips[0].attrs.original).toBe('Dr. Müller')

    const texts = content.filter((n) => n.type === 'text') as TipTapTextNode[]
    expect(texts).toHaveLength(1)
    expect(texts[0].text).toBe(' wohnt hier')
  })

  it('handles entity in middle of text', () => {
    const segments = [seg('Wir sind in Zürich geblieben', 'Person A')]
    const entities: MergedEntity[] = [entity('Zürich', 'ORT', 0, 12, 18)]
    const entityMap = buildEntityMap(entities)
    const doc = buildTipTapDocument(segments, entityMap, entities, 1)

    const content = doc.content[0].content
    expect(content).toHaveLength(3) // text + chip + text
    expect(content[0].type).toBe('text')
    expect((content[0] as TipTapTextNode).text).toBe('Wir sind in ')
    expect(content[1].type).toBe('placeholderChip')
    expect(content[2].type).toBe('text')
    expect((content[2] as TipTapTextNode).text).toBe(' geblieben')
  })

  it('adds speaker labels for multi-speaker transcripts', () => {
    const segments = [seg('Hallo', 'Person A', 10, 15), seg('Hi zurück', 'Person B', 16, 20)]
    const doc = buildTipTapDocument(segments, {}, [], 2)

    const content = doc.content[0].content
    const timestamps = content.filter((n) => n.type === 'timestamp') as TipTapTimestamp[]
    const speakers = content.filter((n) => n.type === 'speakerLabel') as TipTapSpeakerLabel[]

    expect(timestamps).toHaveLength(1)
    expect(timestamps[0].attrs.seconds).toBe(10)
    expect(timestamps[0].attrs.formatted).toBe('00:00:10')

    expect(speakers).toHaveLength(1)
    expect(speakers[0].attrs.speaker).toBe('A')
    expect(speakers[0].attrs.label).toBe('Person A')
  })

  it('does NOT add speaker labels for single-speaker transcripts', () => {
    const segments = [seg('Hallo Welt', 'Person A')]
    const doc = buildTipTapDocument(segments, {}, [], 1)

    const content = doc.content[0].content
    const speakers = content.filter((n) => n.type === 'speakerLabel')
    const timestamps = content.filter((n) => n.type === 'timestamp')
    expect(speakers).toHaveLength(0)
    expect(timestamps).toHaveLength(0)
  })

  it('creates empty paragraph for empty segments array', () => {
    const doc = buildTipTapDocument([], {}, [], 0)
    expect(doc.content).toHaveLength(1)
    expect(doc.content[0].content).toHaveLength(1)
    const node = doc.content[0].content[0]
    expect(node.type).toBe('text')
    expect((node as TipTapTextNode).text).toBe('')
  })

  it('formats timestamps correctly', () => {
    const segments = [seg('Test', 'Person A', 3723, 3780)] // 1h 2m 3s
    const doc = buildTipTapDocument(segments, {}, [], 2)

    const content = doc.content[0].content
    const timestamps = content.filter((n) => n.type === 'timestamp') as TipTapTimestamp[]
    expect(timestamps[0].attrs.formatted).toBe('01:02:03')
  })

  it('handles multiple entities in one segment', () => {
    const segments = [seg('Müller und Schmidt sind hier', 'Person A')]
    const entities: MergedEntity[] = [
      entity('Müller', 'PERSON', 0, 0, 6, 'Müller'),
      entity('Schmidt', 'PERSON', 0, 11, 18, 'Schmidt')
    ]
    const entityMap = buildEntityMap(entities)
    const doc = buildTipTapDocument(segments, entityMap, entities, 1)

    const content = doc.content[0].content
    const chips = content.filter((n) => n.type === 'placeholderChip') as TipTapPlaceholderChip[]
    expect(chips).toHaveLength(2)
    expect(chips[0].attrs.entityId).toBe('person-1')
    expect(chips[1].attrs.entityId).toBe('person-2')
  })

  it('handles entities across multiple segments', () => {
    const segments = [
      seg('Herr Müller wohnt in Bern', 'Person A'),
      seg('Frau Schmidt lebt in Zürich', 'Person B')
    ]
    const entities: MergedEntity[] = [
      entity('Herr Müller', 'PERSON', 0, 0, 11, 'Herr Müller'),
      entity('Bern', 'ORT', 0, 21, 25),
      entity('Frau Schmidt', 'PERSON', 1, 0, 12, 'Frau Schmidt'),
      entity('Zürich', 'ORT', 1, 21, 27)
    ]
    const entityMap = buildEntityMap(entities)
    const doc = buildTipTapDocument(segments, entityMap, entities, 1)

    expect(doc.content).toHaveLength(2)

    const chips0 = doc.content[0].content.filter((n) => n.type === 'placeholderChip')
    expect(chips0).toHaveLength(2)

    const chips1 = doc.content[1].content.filter((n) => n.type === 'placeholderChip')
    expect(chips1).toHaveLength(2)
  })
})
