import { describe, it, expect } from 'vitest'
import { tiptapParagraphToText, tiptapToText, type TipTapTextOptions } from '../tiptapToText'

const EXPORT: TipTapTextOptions = { includeSpeakers: true, includeTimestamps: true, compact: false }
const COMPACT: TipTapTextOptions = {
  includeSpeakers: false,
  includeTimestamps: false,
  compact: true
}

const chip = (attrs: Record<string, unknown>): object => ({ type: 'placeholderChip', attrs })

const metaParagraph = {
  type: 'paragraph',
  content: [
    { type: 'timestamp', attrs: { seconds: 5, formatted: '00:00:05' } },
    { type: 'text', text: ' ' },
    { type: 'speakerLabel', attrs: { speaker: 'B', label: 'Person B' } },
    { type: 'text', text: ' Ja.' }
  ]
}

describe('tiptapToText', () => {
  it('switches speaker labels and timestamps independently', () => {
    const doc = { type: 'doc', content: [metaParagraph] }
    const base = { compact: false }
    expect(tiptapToText(doc, { ...base, includeSpeakers: true, includeTimestamps: false })).toBe(
      '[Person B]: Ja.'
    )
    expect(tiptapToText(doc, { ...base, includeSpeakers: false, includeTimestamps: true })).toBe(
      '[00:00:05]  Ja.'
    )
  })

  it('never emits the original of a chip, in any mode', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [chip({ type: 'PERSON', number: 4, original: 'Lea Zbinden', entityId: 'x' })]
        }
      ]
    }
    for (const options of [EXPORT, COMPACT]) {
      const text = tiptapToText(doc, options)
      expect(text).toBe('[PERSON 4]')
      expect(text).not.toContain('Zbinden')
    }
  })

  describe('unvalidated JSON', () => {
    it.each([null, undefined, 'doc', 42, [], {}])('returns "" for %j', (doc) => {
      expect(tiptapToText(doc, EXPORT)).toBe('')
      expect(tiptapToText(doc, COMPACT)).toBe('')
    })

    it('treats non-array content as empty instead of throwing', () => {
      expect(tiptapToText({ type: 'doc', content: { 0: 'x' } }, EXPORT)).toBe('')
      expect(
        tiptapToText({ type: 'doc', content: [{ type: 'paragraph', content: 'abc' }] }, EXPORT)
      ).toBe('')
    })

    it('drops broken nodes instead of printing "undefined" or "null"', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text' },
              { type: 'text', text: 7 },
              chip({ type: null, number: 1 }),
              chip({ type: 'ORT', number: null }),
              { type: 'placeholderChip' },
              { type: 'speakerLabel', attrs: {} },
              { type: 'timestamp' },
              null,
              'stray',
              { type: 'text', text: 'ok' }
            ]
          }
        ]
      }
      expect(tiptapToText(doc, EXPORT)).toBe('ok')
    })
  })
})

describe('tiptapParagraphToText', () => {
  it('keeps the paragraph verbatim unless compact', () => {
    expect(tiptapParagraphToText(metaParagraph, EXPORT)).toBe('[00:00:05] [Person B]: Ja.')
    expect(tiptapParagraphToText(metaParagraph, { ...COMPACT, compact: false })).toBe('  Ja.')
    expect(tiptapParagraphToText(metaParagraph, COMPACT)).toBe('Ja.')
  })

  it('returns "" for a missing paragraph', () => {
    expect(tiptapParagraphToText(undefined, EXPORT)).toBe('')
  })
})
