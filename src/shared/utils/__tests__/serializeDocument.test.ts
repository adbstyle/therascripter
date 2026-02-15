import { describe, it, expect } from 'vitest'
import { serializeDocument } from '../serializeDocument'
import type { TipTapDocument } from '../../types/TipTapDocument'

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
})
