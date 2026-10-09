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

  it('drops speakerLabel and timestamp nodes (noise for LLM)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'speakerLabel', attrs: { speaker: 'SPEAKER_00' } },
            { type: 'timestamp', attrs: { seconds: 12.3 } },
            { type: 'text', text: 'Hallo.' }
          ]
        }
      ]
    }
    expect(tiptapToPlainText(doc)).toBe('Hallo.')
  })

  it('returns empty string for malformed input', () => {
    expect(tiptapToPlainText(null)).toBe('')
    expect(tiptapToPlainText(undefined)).toBe('')
    expect(tiptapToPlainText({})).toBe('')
  })
})
