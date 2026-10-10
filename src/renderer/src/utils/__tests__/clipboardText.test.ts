import { describe, it, expect, afterEach } from 'vitest'
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { serializeClipboardText } from '../clipboardText'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'
import { buildTipTapDocument } from '../../../../main/ml/tiptap-builder'
import { buildEntityMap } from '../../../../main/ml/entity-map-builder'
import { serializeDocument } from '../../../../shared/utils/serializeDocument'
import type { TranscriptSegment } from '../../../../shared/types'
import type { MergedEntity } from '../../../../shared/types/NerTypes'
import type { TipTapDocument } from '../../../../shared/types/TipTapDocument'

let handle: TestEditorHandle | null = null

afterEach(() => {
  handle?.destroy()
  handle = null
})

function multiSpeakerDoc(): TipTapDocument {
  const segments: TranscriptSegment[] = [
    { text: 'Anna kam spät.', start: 12, end: 14, speaker: 'Person A' },
    { text: 'Warum?', start: 15, end: 16, speaker: 'Person B' }
  ]
  const entities: MergedEntity[] = [
    { text: 'Anna', type: 'PERSON', source: 'ner', segmentIndex: 0, charStart: 0, charEnd: 4 }
  ]
  return buildTipTapDocument(segments, buildEntityMap(entities), entities, 2)
}

/** Doc range of the first occurrence of `needle` inside a single text node. */
function rangeOf(doc: PMNode, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (found || !node.isText) return
    const index = node.text!.indexOf(needle)
    if (index >= 0) found = { from: pos + index, to: pos + index + needle.length }
  })
  if (!found) throw new Error(`"${needle}" not in doc`)
  return found
}

function copyAll(editor: TestEditorHandle['editor']): string {
  return serializeClipboardText(new AllSelection(editor.state.doc).content())
}

describe('serializeClipboardText', () => {
  it('copies a whole multi-speaker document exactly like the audio export', () => {
    const doc = multiSpeakerDoc()
    handle = createTestEditor(doc)

    const text = copyAll(handle.editor)
    expect(text).toBe('[00:00:12] [Person A]: [PERSON 1] kam spät.\n[00:00:15] [Person B]: Warum?')
    expect(text).toBe(serializeDocument(doc, 'audio'))
    expect(text).not.toContain('Anna')
  })

  it('keeps a partial selection verbatim, including leading/trailing spaces', () => {
    handle = createTestEditor(multiSpeakerDoc())
    const { from, to } = rangeOf(handle.editor.state.doc, ' kam ')

    const slice = TextSelection.create(handle.editor.state.doc, from, to).content()
    expect(serializeClipboardText(slice)).toBe(' kam ')
  })

  it('copies a selection spanning two paragraphs, chip and speaker meta included', () => {
    handle = createTestEditor(multiSpeakerDoc())
    const doc = handle.editor.state.doc
    const from = rangeOf(doc, ' kam').from
    const to = rangeOf(doc, 'Warum').to

    const slice = TextSelection.create(doc, from, to).content()
    expect(serializeClipboardText(slice)).toBe(' kam spät.\n[00:00:15] [Person B]: Warum')
  })

  it('skips leading empty paragraphs but keeps inner and trailing ones as newlines', () => {
    handle = createTestEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'A' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        { type: 'paragraph', content: [] }
      ]
    })
    expect(copyAll(handle.editor)).toBe('A\n\nB\n')
  })

  it('drops hard breaks (Shift+Enter) without a separator', () => {
    // hardBreak ist Teil des StarterKit-Schemas, aber nicht von TipTapDocument
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Zeile 1' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Zeile 2' }
          ]
        }
      ]
    } as unknown as TipTapDocument
    handle = createTestEditor(doc)
    expect(copyAll(handle.editor)).toBe('Zeile 1Zeile 2')
  })

  it('returns an empty string for a selected chip (slice holds the bare chip, no paragraph)', () => {
    handle = createTestEditor(multiSpeakerDoc())
    const chip = handle.getChips()[0]

    const slice = NodeSelection.create(handle.editor.state.doc, chip.pos).content()
    expect(serializeClipboardText(slice)).toBe('')
  })
})
