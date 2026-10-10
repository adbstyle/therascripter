import { describe, it, expect } from 'vitest'
import { serializeDocument } from '../serializeDocument'
import { buildTipTapDocument } from '../../../main/ml/tiptap-builder'
import { buildEntityMap } from '../../../main/ml/entity-map-builder'
import type { TranscriptSegment } from '../../types'
import type { MergedEntity } from '../../types/NerTypes'
import type { TipTapDocument } from '../../types/TipTapDocument'

function para(...texts: string[]): TipTapDocument['content'][number] {
  return { type: 'paragraph', content: texts.map((text) => ({ type: 'text', text })) }
}

describe('serializeDocument', () => {
  it('serializes text nodes', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hallo Welt' }]
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('Hallo Welt')
  })

  it('serializes placeholder chips as [TYPE NUMBER]', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Das ist ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Dr. Müller'
              }
            },
            { type: 'text', text: ' aus ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'ort-1',
                type: 'ORT',
                number: 1,
                source: 'ner',
                original: 'Zürich'
              }
            }
          ]
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('Das ist [PERSON 1] aus [ORT 1]')
  })

  it('serializes speaker labels and timestamps for audio sessions', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'timestamp',
              attrs: { seconds: 12, formatted: '00:00:12' }
            },
            { type: 'text', text: ' ' },
            {
              type: 'speakerLabel',
              attrs: { speaker: 'A', label: 'Person A' }
            },
            { type: 'text', text: ' Guten Tag.' }
          ]
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('[00:00:12] [Person A]: Guten Tag.')
  })

  it('omits speaker labels and timestamps for PDF sessions', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'timestamp',
              attrs: { seconds: 12, formatted: '00:00:12' }
            },
            { type: 'text', text: ' ' },
            {
              type: 'speakerLabel',
              attrs: { speaker: 'A', label: 'Person A' }
            },
            { type: 'text', text: ' Text mit ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Name'
              }
            }
          ]
        }
      ]
    }
    expect(serializeDocument(doc, 'pdf')).toBe('Text mit [PERSON 1]')
  })

  it('joins paragraphs with newlines', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Erster Absatz.' }]
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Zweiter Absatz.' }]
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('Erster Absatz.\nZweiter Absatz.')
  })

  it('handles empty document', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: []
    }
    expect(serializeDocument(doc, 'audio')).toBe('')
  })

  it('handles paragraph with no content array', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: []
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('')
  })

  it('serializes all placeholder types correctly', () => {
    const types = [
      'PERSON',
      'ORT',
      'DATUM',
      'KONTAKT',
      'ORGANISATION',
      'MEDIZINISCH',
      'SONSTIGES'
    ] as const

    for (const type of types) {
      const doc: TipTapDocument = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'placeholderChip',
                attrs: {
                  entityId: `${type.toLowerCase()}-1`,
                  type,
                  number: 1,
                  source: 'ner',
                  original: 'test'
                }
              }
            ]
          }
        ]
      }
      expect(serializeDocument(doc, 'audio')).toBe(`[${type} 1]`)
    }
  })

  it('trims trailing whitespace from output', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Text' }]
        },
        {
          type: 'paragraph',
          content: []
        }
      ]
    }
    expect(serializeDocument(doc, 'audio')).toBe('Text')
  })

  it('serializes a realistic audio document', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'timestamp',
              attrs: { seconds: 12, formatted: '00:00:12' }
            },
            { type: 'text', text: ' ' },
            {
              type: 'speakerLabel',
              attrs: { speaker: 'A', label: 'Person A' }
            },
            { type: 'text', text: ' Guten Tag, wie geht es Ihnen?' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'timestamp',
              attrs: { seconds: 45, formatted: '00:00:45' }
            },
            { type: 'text', text: ' ' },
            {
              type: 'speakerLabel',
              attrs: { speaker: 'B', label: 'Person B' }
            },
            { type: 'text', text: ' Ja, seit dem Termin bei ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Dr. Müller'
              }
            },
            { type: 'text', text: ' in ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'ort-1',
                type: 'ORT',
                number: 1,
                source: 'ner',
                original: 'Zürich'
              }
            },
            { type: 'text', text: ' habe ich viel nachgedacht.' }
          ]
        }
      ]
    }

    const expected = [
      '[00:00:12] [Person A]: Guten Tag, wie geht es Ihnen?',
      '[00:00:45] [Person B]: Ja, seit dem Termin bei [PERSON 1] in [ORT 1] habe ich viel nachgedacht.'
    ].join('\n')

    expect(serializeDocument(doc, 'audio')).toBe(expected)
  })

  describe('documents built by buildTipTapDocument', () => {
    const multiSpeaker = (): TipTapDocument => {
      const segments: TranscriptSegment[] = [
        { text: 'Anna kam aus Bern.', start: 12, end: 14, speaker: 'Person A' },
        { text: 'Warum?', start: 3725, end: 3726, speaker: 'Person B' }
      ]
      const entities: MergedEntity[] = [
        { text: 'Anna', type: 'PERSON', source: 'ner', segmentIndex: 0, charStart: 0, charEnd: 4 },
        { text: 'Bern', type: 'ORT', source: 'ner', segmentIndex: 0, charStart: 13, charEnd: 17 }
      ]
      return buildTipTapDocument(segments, buildEntityMap(entities), entities, 2)
    }

    it('renders timestamp, speaker label and chips for a multi-speaker audio session', () => {
      const text = serializeDocument(multiSpeaker(), 'audio')
      expect(text).toBe(
        '[00:00:12] [Person A]: [PERSON 1] kam aus [ORT 1].\n[01:02:05] [Person B]: Warum?'
      )
      expect(text).not.toContain('Anna')
      expect(text).not.toContain('Bern')
    })

    it('keeps the builder spacers of dropped meta nodes in "pdf" mode (only the whole text is trimmed)', () => {
      expect(serializeDocument(multiSpeaker(), 'pdf')).toBe('[PERSON 1] kam aus [ORT 1].\n  Warum?')
    })

    it('keeps the trailing spacer of a paragraph with an empty segment', () => {
      const segments: TranscriptSegment[] = [
        { text: '', start: 0, end: 1, speaker: 'Person A' },
        { text: 'Ja.', start: 2, end: 3, speaker: 'Person B' }
      ]
      const doc = buildTipTapDocument(segments, {}, [], 2)
      expect(serializeDocument(doc, 'audio')).toBe(
        '[00:00:00] [Person A]: \n[00:00:02] [Person B]: Ja.'
      )
    })

    it('renders a single-speaker audio session without labels', () => {
      const segments: TranscriptSegment[] = [
        { text: 'Hans wohnt hier.', start: 0, end: 2, speaker: 'Person A' },
        { text: 'Seit Jahren.', start: 3, end: 4, speaker: 'Person A' }
      ]
      const entities: MergedEntity[] = [
        { text: 'Hans', type: 'PERSON', source: 'ner', segmentIndex: 0, charStart: 0, charEnd: 4 }
      ]
      const doc = buildTipTapDocument(segments, buildEntityMap(entities), entities, 1)
      expect(serializeDocument(doc, 'audio')).toBe('[PERSON 1] wohnt hier.\nSeit Jahren.')
    })

    it('renders a PDF session (segments without speaker)', () => {
      const segments: TranscriptSegment[] = [
        { text: 'Befund von Dr. Keller.', start: 0, end: 0 },
        { text: 'Kontrolle in Basel.', start: 0, end: 0 }
      ]
      const entities: MergedEntity[] = [
        {
          text: 'Dr. Keller',
          type: 'PERSON',
          source: 'ner',
          segmentIndex: 0,
          charStart: 11,
          charEnd: 21
        },
        { text: 'Basel', type: 'ORT', source: 'ner', segmentIndex: 1, charStart: 13, charEnd: 18 }
      ]
      const doc = buildTipTapDocument(segments, buildEntityMap(entities), entities, 0)
      expect(serializeDocument(doc, 'pdf')).toBe('Befund von [PERSON 1].\nKontrolle in [ORT 1].')
    })

    it('returns an empty string for an empty transcript', () => {
      expect(serializeDocument(buildTipTapDocument([], {}, [], 0), 'audio')).toBe('')
    })
  })

  describe('paragraph layout', () => {
    it('drops leading/trailing empty paragraphs but keeps inner ones as blank lines', () => {
      const doc: TipTapDocument = {
        type: 'doc',
        content: [para(), para('A'), para(), para('B'), para()]
      }
      expect(serializeDocument(doc, 'audio')).toBe('A\n\nB')
    })

    it('trims only the ends of the whole text, not each paragraph', () => {
      const doc: TipTapDocument = { type: 'doc', content: [para(' A '), para(' B ')] }
      expect(serializeDocument(doc, 'pdf')).toBe('A \n B')
    })

    it('concatenates split text nodes (e.g. around marks) without separator', () => {
      const doc: TipTapDocument = { type: 'doc', content: [para('Das ist ', 'fett', '.')] }
      expect(serializeDocument(doc, 'pdf')).toBe('Das ist fett.')
    })

    it('ignores text marks and hard breaks from editor JSON', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Zeile ', marks: [{ type: 'bold' }] },
              { type: 'hardBreak' },
              { type: 'text', text: 'zwei' }
            ]
          }
        ]
      } as unknown as TipTapDocument
      expect(serializeDocument(doc, 'audio')).toBe('Zeile zwei')
    })
  })
})
