import { describe, it, expect } from 'vitest'
import { tiptapToPlainText } from '../tiptap-plain-text'
import { buildTipTapDocument } from '../tiptap-builder'
import { buildEntityMap } from '../entity-map-builder'
import type { TranscriptSegment } from '../../../shared/types'
import type { MergedEntity } from '../../../shared/types/NerTypes'

describe('tiptapToPlainText', () => {
  it('joins text nodes across paragraphs with newlines', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Satz A.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Satz B.' }] }
      ]
    }
    expect(tiptapToPlainText(doc)).toBe('Satz A.\nSatz B.')
  })

  it('renders placeholderChip nodes as [TYPE NUMBER], never the original', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Der Patient ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Hans Muster'
              }
            },
            { type: 'text', text: ' war müde.' }
          ]
        }
      ]
    }
    const text = tiptapToPlainText(doc)
    expect(text).toBe('Der Patient [PERSON 1] war müde.')
    expect(text).not.toContain('Hans Muster')
  })

  it('keeps placeholders from a document built by buildTipTapDocument', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Dr. Müller wohnt in Bern.', start: 0, end: 1, speaker: 'Person A' }
    ]
    const entities: MergedEntity[] = [
      {
        text: 'Dr. Müller',
        type: 'PERSON',
        source: 'ner',
        segmentIndex: 0,
        charStart: 0,
        charEnd: 10
      },
      { text: 'Bern', type: 'ORT', source: 'ner', segmentIndex: 0, charStart: 20, charEnd: 24 }
    ]
    const doc = buildTipTapDocument(segments, buildEntityMap(entities), entities, 1)

    const text = tiptapToPlainText(doc)
    expect(text).toBe('[PERSON 1] wohnt in [ORT 1].')
    expect(text).not.toContain('Müller')
    expect(text).not.toContain('Bern')
  })

  it('drops speaker labels, timestamps and their spacers from multi-speaker docs', () => {
    const segments: TranscriptSegment[] = [
      { text: 'Anna kam spät.', start: 12, end: 14, speaker: 'Person A' },
      { text: 'Warum?', start: 15, end: 16, speaker: 'Person B' }
    ]
    const entities: MergedEntity[] = [
      { text: 'Anna', type: 'PERSON', source: 'ner', segmentIndex: 0, charStart: 0, charEnd: 4 }
    ]
    const doc = buildTipTapDocument(segments, buildEntityMap(entities), entities, 2)

    expect(tiptapToPlainText(doc)).toBe('[PERSON 1] kam spät.\nWarum?')
  })

  it('skips paragraphs that hold nothing but speaker label and timestamp', () => {
    const segments: TranscriptSegment[] = [
      { text: '', start: 0, end: 1, speaker: 'Person A' },
      { text: 'Ja.', start: 2, end: 3, speaker: 'Person B' }
    ]
    const doc = buildTipTapDocument(segments, {}, [], 2)

    expect(tiptapToPlainText(doc)).toBe('Ja.')
  })

  it('skips chips whose type or number is null instead of printing "null"', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'placeholderChip', attrs: { type: null, number: null } },
            { type: 'text', text: 'und ' },
            { type: 'placeholderChip', attrs: { type: 'PERSON', number: 2 } }
          ]
        }
      ]
    }
    expect(tiptapToPlainText(doc)).toBe('und [PERSON 2]')
  })

  it('returns empty string for malformed input', () => {
    expect(tiptapToPlainText(null)).toBe('')
    expect(tiptapToPlainText(undefined)).toBe('')
    expect(tiptapToPlainText({})).toBe('')
  })
})
