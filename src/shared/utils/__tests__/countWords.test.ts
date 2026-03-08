import { describe, it, expect } from 'vitest'
import { countWords } from '../countWords'
import type { TipTapDocument } from '../../types/TipTapDocument'

describe('countWords', () => {
  it('counts words in text nodes', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hallo Welt drei Worte' }]
        }
      ]
    }
    expect(countWords(doc)).toBe(4)
  })

  it('counts placeholder chips as one word each', () => {
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
                original: 'Dr. Mueller'
              }
            },
            { type: 'text', text: ' aus Bern' }
          ]
        }
      ]
    }
    expect(countWords(doc)).toBe(5)
  })

  it('ignores speaker labels and timestamps', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'speakerLabel', attrs: { speaker: 'A', label: 'Person A' } },
            { type: 'timestamp', attrs: { seconds: 10, formatted: '00:00:10' } },
            { type: 'text', text: 'Ein Wort' }
          ]
        }
      ]
    }
    expect(countWords(doc)).toBe(2)
  })

  it('returns 0 for empty document', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: []
    }
    expect(countWords(doc)).toBe(0)
  })

  it('returns 0 for paragraph with no content', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }]
    }
    expect(countWords(doc)).toBe(0)
  })

  it('handles whitespace-only text nodes', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '   ' }]
        }
      ]
    }
    expect(countWords(doc)).toBe(0)
  })

  it('counts words across multiple paragraphs', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Erster Absatz' }]
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Zweiter Absatz hier' }]
        }
      ]
    }
    expect(countWords(doc)).toBe(5)
  })

  it('handles multiple text nodes in a single paragraph', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Teil eins' },
            { type: 'text', text: ' Teil zwei' }
          ]
        }
      ]
    }
    expect(countWords(doc)).toBe(4)
  })
})
