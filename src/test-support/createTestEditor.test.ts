import { describe, it, expect, afterEach } from 'vitest'
import { createTestEditor, type TestEditorHandle } from './createTestEditor'

describe('createTestEditor', () => {
  let handle: TestEditorHandle | null = null

  afterEach(() => {
    handle?.destroy()
    handle = null
  })

  it('boots an empty editor with a paragraph', () => {
    handle = createTestEditor()
    const { editor } = handle
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(handle.getChips()).toEqual([])
  })

  it('inserts text and reads it back', () => {
    handle = createTestEditor()
    handle.insertText(1, 'Hallo Müller')
    expect(handle.editor.state.doc.textContent).toBe('Hallo Müller')
  })

  it('inserts a chip and reads it back', () => {
    handle = createTestEditor()
    handle.insertText(1, 'foo bar')
    handle.insertChip(5, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'manual',
      original: 'baz'
    })
    const chips = handle.getChips()
    expect(chips).toHaveLength(1)
    expect(chips[0].entityId).toBe('person-1')
    expect(chips[0].original).toBe('baz')
    expect(chips[0].nodeSize).toBe(1)
  })

  it('replaces a chip via tr.replaceWith and the chip is gone', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'ner',
      original: 'Anna'
    })
    expect(handle.getChips()).toHaveLength(1)
    const { editor } = handle
    const chipPos = handle.getChips()[0].pos
    const tr = editor.state.tr.replaceWith(
      chipPos,
      chipPos + 1,
      editor.state.schema.text('Anna')
    )
    editor.view.dispatch(tr)
    expect(handle.getChips()).toHaveLength(0)
    expect(editor.state.doc.textContent).toBe('Anna')
  })

  it('setSelection moves the cursor to the requested range', () => {
    handle = createTestEditor()
    handle.insertText(1, 'Hello world')
    handle.setSelection(2, 6)
    expect(handle.editor.state.selection.from).toBe(2)
    expect(handle.editor.state.selection.to).toBe(6)
  })

  it('does NOT crash from React node-view rendering in jsdom', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'ort-1',
      type: 'ORT',
      number: 1,
      source: 'ner',
      original: 'Bern'
    })
    expect(handle.editor.view.dom.innerHTML).toContain('placeholderChip')
  })
})
