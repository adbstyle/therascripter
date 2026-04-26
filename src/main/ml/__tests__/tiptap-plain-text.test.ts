import { describe, it, expect } from 'vitest'
import { tiptapToPlainText } from '../tiptap-plain-text'

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

  it('renders placeholderChip nodes using their label attribute', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Der Patient ' },
            { type: 'placeholderChip', attrs: { label: '[PERSON 1]' } },
            { type: 'text', text: ' war müde.' }
          ]
        }
      ]
    }
    expect(tiptapToPlainText(doc)).toBe('Der Patient [PERSON 1] war müde.')
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
