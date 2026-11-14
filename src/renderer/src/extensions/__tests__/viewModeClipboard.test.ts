import { describe, it, expect, afterEach } from 'vitest'
import { NodeSelection } from '@tiptap/pm/state'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'
import { getViewModeStore, _resetViewModeStoreForTests } from '../../viewMode/viewModeStore'
import { serializeClipboardText } from '../../utils/clipboardText'
import type {
  TipTapDocument,
  TipTapPlaceholderChipAttrs
} from '../../../../shared/types/TipTapDocument'
import type { ViewMode } from '../../../../shared/types/ViewMode'

/**
 * Issue #203 AK 9 — every way of copying out of the editor yields the chosen
 * view: Cmd+C, Cmd+X and dragging text out, each in text/plain AND text/html.
 * Real ClipboardEvents through ProseMirror's own handlers, against the
 * production schema (createTestEditor). jsdom has no DataTransfer, so the
 * clipboard is a minimal stand-in.
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
  _resetViewModeStoreForTests()
})

function setMode(mode: ViewMode): void {
  getViewModeStore().set(mode)
}

/** Opens an editor; in the Klartext view read-only, as ReviewEditor does. */
function open(mode: ViewMode): TestEditorHandle {
  setMode(mode)
  const handle = createTestEditor({
    initialDoc: transcript(),
    clipboardTextSerializer: serializeClipboardText
  })
  handle.editor.setEditable(mode !== 'plain', false)
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
          { type: 'text', text: ' und ' },
          // stored without original (e.g. legacy data) — stays a placeholder (AK 6)
          chip('', { entityId: 'person-2', number: 2 }),
          { type: 'text', text: ' da ist.' }
        ]
      },
      { type: 'paragraph', content: [] }
    ]
  }
}

const PSEUDONYMIZED_LINE =
  '[00:00:12] [Person A]: Hallo [PERSON 1], schön, dass [PERSON 1] aus [ORT 1] und [PERSON 2] da ist.'
const PLAIN_LINE =
  '[00:00:12] [Person A]: Hallo Ruth Gerber, schön, dass Frau Gerber aus Bern und [PERSON 2] da ist.'
const ORIGINALS = ['Ruth Gerber', 'Frau Gerber', 'Bern']

function fire(handle: TestEditorHandle, type: 'copy' | 'cut' | 'paste', data: FakeClipboardData) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })
  handle.editor.view.dom.dispatchEvent(event)
}

function selectFirstParagraph(handle: TestEditorHandle): void {
  const first = handle.editor.state.doc.firstChild!
  handle.setSelection(1, 1 + first.content.size)
}

function copyFirstParagraph(handle: TestEditorHandle, type: 'copy' | 'cut' = 'copy') {
  selectFirstParagraph(handle)
  const data = new FakeClipboardData()
  fire(handle, type, data)
  return data
}

/** Drag start of the current selection; returns what lands in the DataTransfer. */
function dragSelection(handle: TestEditorHandle): FakeClipboardData {
  const data = new FakeClipboardData()
  const dataTransfer = {
    files: [],
    clearData: () => data.clearData(),
    setData: (type: string, value: string) => data.setData(type, value),
    effectAllowed: ''
  }
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  document.elementFromPoint = () => null
  handle.editor.view.dom.dispatchEvent(event)
  return data
}

function firstLine(handle: TestEditorHandle): string {
  return handle.editor.state.doc.firstChild!.textContent
}

describe('pseudonymized view — unchanged behavior', () => {
  it('Cmd+C: tokens in text/plain, chip markup without originals in text/html', () => {
    const handle = open('pseudonymized')
    const data = copyFirstParagraph(handle)

    expect(data.getData('text/plain')).toBe(PSEUDONYMIZED_LINE)
    const html = data.getData('text/html')
    expect(html).toContain('data-type="placeholderChip"')
    for (const original of ORIGINALS) expect(html).not.toContain(original)
  })

  it('Cmd+X: cuts and carries tokens only', () => {
    const handle = open('pseudonymized')
    const data = copyFirstParagraph(handle, 'cut')

    expect(data.getData('text/plain')).toBe(PSEUDONYMIZED_LINE)
    for (const original of ORIGINALS) expect(data.getData('text/html')).not.toContain(original)
    expect(handle.getChips()).toHaveLength(0)
  })

  it('drag: tokens only', () => {
    const handle = open('pseudonymized')
    selectFirstParagraph(handle)
    const data = dragSelection(handle)

    expect(data.getData('text/plain')).toBe(PSEUDONYMIZED_LINE)
    for (const original of ORIGINALS) expect(data.getData('text/html')).not.toContain(original)
  })

  it('a copied chip still gets its original back on paste in the same editor', () => {
    const handle = open('pseudonymized')
    const data = copyFirstParagraph(handle)
    const end = handle.editor.state.doc.content.size - 1
    handle.setSelection(end, end)
    fire(handle, 'paste', data)

    const pasted = handle.getChips().slice(4)
    expect(pasted.map((c) => c.original)).toEqual([...ORIGINALS, ''])
  })
})

describe('Klartext view', () => {
  it('Cmd+C: originals in text/plain, placeholder where none is stored', () => {
    const handle = open('plain')
    expect(copyFirstParagraph(handle).getData('text/plain')).toBe(PLAIN_LINE)
  })

  it('Cmd+C: text/html is ordinary text — originals, no chip markup', () => {
    const handle = open('plain')
    const html = copyFirstParagraph(handle).getData('text/html')

    for (const original of ORIGINALS) expect(html).toContain(original)
    expect(html).toContain('[PERSON 2]')
    expect(html).not.toContain('placeholderChip')
  })

  it('Cmd+X copies the Klartext and changes nothing (AK 8)', () => {
    const handle = open('plain')
    const before = JSON.stringify(handle.editor.getJSON())
    const data = copyFirstParagraph(handle, 'cut')

    expect(data.getData('text/plain')).toBe(PLAIN_LINE)
    expect(data.getData('text/html')).not.toContain('placeholderChip')
    expect(JSON.stringify(handle.editor.getJSON())).toBe(before)
  })

  it('dragging text out carries the Klartext in both flavors', () => {
    const handle = open('plain')
    selectFirstParagraph(handle)
    const data = dragSelection(handle)

    expect(data.getData('text/plain')).toBe(PLAIN_LINE)
    expect(data.getData('text/html')).toContain('Ruth Gerber')
    expect(data.getData('text/html')).not.toContain('placeholderChip')
  })

  it('a single selected chip copies as its original', () => {
    const handle = open('plain')
    const chipPos = handle.getChips()[0].pos
    const { state, view } = handle.editor
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, chipPos)))
    const data = new FakeClipboardData()
    fire(handle, 'copy', data)

    expect(data.getData('text/plain')).toBe('Ruth Gerber')
    expect(data.getData('text/html')).not.toContain('placeholderChip')
  })

  it('copied Klartext pasted in the pseudonymized view is ordinary text (Out of Scope 7)', () => {
    const source = open('plain')
    const data = copyFirstParagraph(source)

    setMode('pseudonymized')
    const target = createTestEditor({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })
    handles.push(target)
    target.setSelection(1, 1)
    fire(target, 'paste', data)

    expect(target.getChips()).toHaveLength(0)
    expect(firstLine(target)).toContain('Hallo Ruth Gerber, schön, dass Frau Gerber aus Bern')
  })

  it('switching the view changes neither document nor chips (Postcondition 1)', () => {
    const handle = open('pseudonymized')
    const before = JSON.stringify(handle.editor.getJSON())
    let updates = 0
    handle.editor.on('update', () => updates++)

    setMode('plain')
    handle.editor.setEditable(false, false)
    copyFirstParagraph(handle)
    setMode('pseudonymized')
    handle.editor.setEditable(true, false)

    expect(JSON.stringify(handle.editor.getJSON())).toBe(before)
    expect(updates).toBe(0)
  })
})
