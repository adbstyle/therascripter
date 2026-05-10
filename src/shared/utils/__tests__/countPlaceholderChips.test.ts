import { describe, it, expect } from 'vitest'
import { countPlaceholderChips } from '../countPlaceholderChips'
import type { TipTapDocument } from '../../types/TipTapDocument'

function chip(entityId: string): {
  type: 'placeholderChip'
  attrs: { entityId: string; type: 'PERSON'; number: number; source: 'ner'; original: string }
} {
  return {
    type: 'placeholderChip',
    attrs: { entityId, type: 'PERSON', number: 1, source: 'ner', original: 'Anna' }
  }
}

describe('countPlaceholderChips', () => {
  it('returns 0 for an empty document', () => {
    const doc: TipTapDocument = { type: 'doc', content: [] }
    expect(countPlaceholderChips(doc)).toBe(0)
  })

  it('returns 0 for a document with only text', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kein chip hier' }] }]
    }
    expect(countPlaceholderChips(doc)).toBe(0)
  })

  it('counts each placeholder chip occurrence (not distinct identities)', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hallo ' },
            chip('person-1'),
            { type: 'text', text: ', ' },
            chip('person-1'),
            { type: 'text', text: ' und ' },
            chip('person-2')
          ]
        }
      ]
    }
    expect(countPlaceholderChips(doc)).toBe(3)
  })

  it('counts chips spread across multiple paragraphs', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [chip('person-1')] },
        { type: 'paragraph', content: [chip('person-2'), chip('person-3')] }
      ]
    }
    expect(countPlaceholderChips(doc)).toBe(3)
  })

  it('ignores speakerLabel and timestamp inline nodes', () => {
    const doc: TipTapDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'timestamp', attrs: { seconds: 0, formatted: '00:00:00' } },
            { type: 'speakerLabel', attrs: { speaker: 'A', label: 'Person A' } },
            chip('person-1'),
            { type: 'text', text: ' sagt etwas' }
          ]
        }
      ]
    }
    expect(countPlaceholderChips(doc)).toBe(1)
  })
})
