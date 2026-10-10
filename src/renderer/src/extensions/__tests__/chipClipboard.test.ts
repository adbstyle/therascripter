import { describe, it, expect, afterEach } from 'vitest'
import { NodeSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'
import { serializeClipboardText } from '../../utils/clipboardText'
import { tiptapParagraphToText } from '../../../../shared/utils/tiptapToText'
import type {
  TipTapDocument,
  TipTapPlaceholderChipAttrs
} from '../../../../shared/types/TipTapDocument'

/**
 * Cmd+C / Cmd+X / Cmd+V end to end: real ClipboardEvents through
 * ProseMirror's own handlers (clipboardSerializer, transformCopied,
 * clipboardParser, transformPasted). jsdom has no DataTransfer, so the
 * clipboard is a minimal stand-in with the three methods ProseMirror calls.
 */
class FakeClipboardData {
  private readonly data = new Map<string, string>()
  setData(type: string, value: string): void {
    this.data.set(type, value)
  }
  getData(type: string): string {
    return this.data.get(type) ?? ''
  }
  clearData(): void {
    this.data.clear()
  }
}

const handles: TestEditorHandle[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
})

function open(sessionId: string, initialDoc: TipTapDocument = transcript()): TestEditorHandle {
  const handle = createTestEditor({ initialDoc, sessionId })
  handles.push(handle)
  return handle
}

function chip(original: string, overrides: Partial<TipTapPlaceholderChipAttrs> = {}) {
  return {
    type: 'placeholderChip' as const,
    attrs: {
      entityId: 'person-1',
      type: 'PERSON' as const,
      number: 1,
      source: 'ner' as const,
      original,
      ...overrides
    }
  }
}

/** Paragraph 1 holds the transcript line, paragraph 2 is the empty paste target. */
function transcript(): TipTapDocument {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'timestamp', attrs: { seconds: 12, formatted: '00:00:12' } },
          { type: 'text', text: ' ' },
          { type: 'speakerLabel', attrs: { speaker: 'A', label: 'Person A' } },
          { type: 'text', text: ' Hallo ' },
          chip('Ruth Gerber'),
          { type: 'text', text: ', schön, dass ' },
          chip('Frau Gerber'),
          { type: 'text', text: ' aus ' },
          chip('Bern', { entityId: 'ort-1', type: 'ORT', source: 'blocklist' }),
          { type: 'text', text: ' da ist.' }
        ]
      },
      { type: 'paragraph', content: [] }
    ]
  }
}

function fire(
  handle: TestEditorHandle,
  type: 'copy' | 'cut' | 'paste',
  data: FakeClipboardData
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  handle.editor.view.dom.dispatchEvent(event)
}

/** Selects the whole first paragraph's content and copies (or cuts) it. */
function copyFirstParagraph(handle: TestEditorHandle, type: 'copy' | 'cut' = 'copy') {
  const first = handle.editor.state.doc.firstChild!
  handle.setSelection(1, 1 + first.content.size)
  const data = new FakeClipboardData()
  fire(handle, type, data)
  return data
}

/** Pastes into the last (empty) paragraph. */
function pasteAtEnd(handle: TestEditorHandle, data: FakeClipboardData): void {
  const end = handle.editor.state.doc.content.size - 1
  handle.setSelection(end, end)
  fire(handle, 'paste', data)
}

function htmlClipboard(html: string): FakeClipboardData {
  const data = new FakeClipboardData()
  data.setData('text/html', html)
  data.setData('text/plain', 'Hallo [PERSON 1]')
  return data
}

/** Paragraph as text/plain renders it — atoms included, unlike `textContent`. */
function lineOf(paragraph: PMNode): string {
  return tiptapParagraphToText(paragraph.toJSON(), {
    includeSpeakers: true,
    includeTimestamps: true,
    compact: false
  })
}

const LINE = '[00:00:12] [Person A]: Hallo [PERSON 1], schön, dass [PERSON 1] aus [ORT 1] da ist.'

function lastParagraphChips(handle: TestEditorHandle) {
  const lastStart =
    handle.editor.state.doc.content.size - handle.editor.state.doc.lastChild!.nodeSize
  return handle.getChips().filter((c) => c.pos > lastStart)
}

describe('copy: text/html flavor', () => {
  it('never contains a chip original', () => {
    const handle = open('session-a')
    const html = copyFirstParagraph(handle).getData('text/html')

    expect(html).toContain('data-type="placeholderChip"')
    expect(html).not.toContain('Ruth Gerber')
    expect(html).not.toContain('Frau Gerber')
    expect(html).not.toContain('Bern')
    expect(html).not.toMatch(/\boriginal=/)
  })

  it('renders chips, speaker labels and timestamps as visible text like text/plain', () => {
    const handle = open('session-a')
    const data = copyFirstParagraph(handle)

    const container = document.createElement('div')
    container.innerHTML = data.getData('text/html')
    expect(container.textContent).toBe(LINE)
    // text/plain comes from ReviewEditor's clipboardTextSerializer (not part
    // of the test editor) — same tokens for the same selection
    expect(serializeClipboardText(handle.editor.state.selection.content())).toBe(LINE)
  })

  it('keeps a lone selected chip out of the HTML too (NodeSelection copy)', () => {
    const handle = open('session-a')
    const { pos } = handle.getChips()[0]
    handle.editor.view.dispatch(
      handle.editor.state.tr.setSelection(NodeSelection.create(handle.editor.state.doc, pos))
    )
    const data = new FakeClipboardData()
    fire(handle, 'copy', data)

    expect(data.getData('text/html')).toContain('[PERSON 1]')
    expect(data.getData('text/html')).not.toContain('Ruth Gerber')
  })
})

describe('paste: chips', () => {
  it('survive copy/paste within the same session with every attribute', () => {
    const handle = open('session-a')
    const copied = handle.getChips().map(({ pos: _p, ...attrs }) => attrs)

    pasteAtEnd(handle, copyFirstParagraph(handle))

    const pasted = lastParagraphChips(handle).map(({ pos: _p, ...attrs }) => attrs)
    expect(pasted).toEqual(copied)
  })

  it('keep their own original variant, not just one per entity', () => {
    const handle = open('session-a')
    pasteAtEnd(handle, copyFirstParagraph(handle))

    expect(lastParagraphChips(handle).map((c) => c.original)).toEqual([
      'Ruth Gerber',
      'Frau Gerber',
      'Bern'
    ])
  })

  it('survive cut/paste within the same session', () => {
    const handle = open('session-a')
    const data = copyFirstParagraph(handle, 'cut')
    expect(handle.getChips()).toEqual([])

    pasteAtEnd(handle, data)

    expect(handle.getChips().map((c) => c.original)).toEqual(['Ruth Gerber', 'Frau Gerber', 'Bern'])
  })

  it('survive a remount of the same session (record outlives the editor)', () => {
    const first = open('session-a')
    const data = copyFirstParagraph(first)
    first.destroy()
    handles.splice(handles.indexOf(first), 1)

    const reopened = open('session-a')
    pasteAtEnd(reopened, data)

    expect(lastParagraphChips(reopened).map((c) => c.original)).toEqual([
      'Ruth Gerber',
      'Frau Gerber',
      'Bern'
    ])
  })

  it("become inert text in another session's editor — no foreign clear name enters it", () => {
    const source = open('session-a')
    const data = copyFirstParagraph(source)

    const target = open('session-b', {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [chip('Hans Muster')] },
        { type: 'paragraph', content: [] }
      ]
    })
    pasteAtEnd(target, data)

    expect(target.getChips().map((c) => c.original)).toEqual(['Hans Muster'])
    expect(lineOf(target.editor.state.doc.lastChild!)).toBe(LINE)
    const json = JSON.stringify(target.editor.getJSON())
    expect(json).not.toContain('Ruth Gerber')
    expect(json).not.toContain('Bern')
  })

  it('become inert text when the HTML was not copied in this session (e.g. older app version)', () => {
    const handle = open('session-c', { type: 'doc', content: [{ type: 'paragraph', content: [] }] })
    pasteAtEnd(
      handle,
      htmlClipboard(
        '<p>Hallo <span data-type="placeholderChip" entityid="person-1" type="PERSON" ' +
          'number="1" source="ner" original="Ruth Gerber"></span></p>'
      )
    )

    expect(lastParagraphChips(handle)).toEqual([])
    expect(handle.editor.state.doc.lastChild!.textContent).toBe('Hallo [PERSON 1]')
    expect(JSON.stringify(handle.editor.getJSON())).not.toContain('Ruth Gerber')
  })

  it('become inert text when chip HTML only resembles the last copy in this session', () => {
    const handle = open('session-d')
    copyFirstParagraph(handle)

    pasteAtEnd(
      handle,
      htmlClipboard(
        '<p>Hallo <span data-type="placeholderChip" entityid="person-1" type="PERSON" ' +
          'number="1" source="ner"></span></p>'
      )
    )

    expect(lastParagraphChips(handle)).toEqual([])
    expect(handle.editor.state.doc.lastChild!.textContent).toBe('Hallo [PERSON 1]')
  })
})
