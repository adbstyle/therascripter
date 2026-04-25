import { describe, it, expect, afterEach } from 'vitest'
import {
  getNextNumber,
  anonymizeSelectionWithPropagation,
  rebuildEntityMapFromDoc,
  addToBlocklistRetroactive
} from '../editorCommands'
import type { EntityMap } from '../../../../shared/types'
import {
  createTestEditor,
  type TestEditorHandle
} from '../../../../test-support/createTestEditor'

describe('getNextNumber', () => {
  it('returns 1 for empty entityMap', () => {
    expect(getNextNumber({}, 'PERSON')).toBe(1)
  })

  it('returns next number for existing entries of the same type', () => {
    const entityMap: EntityMap = {
      'person-1': {
        original: 'Dr. Müller',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      },
      'person-2': {
        original: 'Hans Weber',
        placeholder: '[PERSON 2]',
        type: 'PERSON',
        source: 'ner'
      }
    }
    expect(getNextNumber(entityMap, 'PERSON')).toBe(3)
  })

  it('ignores entries of different types', () => {
    const entityMap: EntityMap = {
      'person-1': {
        original: 'Dr. Müller',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      },
      'ort-1': {
        original: 'Zürich',
        placeholder: '[ORT 1]',
        type: 'ORT',
        source: 'ner'
      }
    }
    expect(getNextNumber(entityMap, 'ORT')).toBe(2)
    expect(getNextNumber(entityMap, 'DATUM')).toBe(1)
  })

  it('does not fill gaps (Decision #140)', () => {
    const entityMap: EntityMap = {
      'person-1': {
        original: 'Dr. Müller',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      },
      'person-3': {
        original: 'Hans Weber',
        placeholder: '[PERSON 3]',
        type: 'PERSON',
        source: 'ner'
      }
    }
    // Next should be 4 (not 2)
    expect(getNextNumber(entityMap, 'PERSON')).toBe(4)
  })
})

let handle: TestEditorHandle | null = null

afterEach(() => {
  handle?.destroy()
  handle = null
})

const emptyMap = (): EntityMap => ({})

const seedDoc = (text: string): TestEditorHandle =>
  createTestEditor({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

describe('anonymizeSelectionWithPropagation', () => {
  it('returns null when selection is empty', () => {
    handle = createTestEditor()
    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())
    expect(result).toBeNull()
  })

  it('returns null when selection is exactly one chip of the same type (AK 11 no-op)', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'manual',
      original: 'Anna'
    })
    const chipPos = handle.getChips()[0].pos
    handle.setSelection(chipPos, chipPos + 1)

    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'manual' }
    }
    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', map)

    expect(result).toBeNull()
    expect(handle.getChips()).toHaveLength(1)
  })

  it('does NOT no-op a single-character text selection', () => {
    handle = seedDoc('i bin Adrian')
    handle.setSelection(1, 2)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(1)
    expect(handle.getChips()).toHaveLength(1)
  })

  it('propagates 3 text occurrences with the same entityId', () => {
    handle = seedDoc('Müller war Müller und Müller.')
    handle.setSelection(1, 7)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(3)
    expect(result!.entityMap[result!.entityId]).toMatchObject({
      placeholder: '[PERSON 1]',
      source: 'manual',
      type: 'PERSON'
    })
    const chips = handle.getChips()
    expect(chips).toHaveLength(3)
    expect(new Set(chips.map((c) => c.entityId)).size).toBe(1)
    expect(chips[0].entityId).toBe(result!.entityId)
  })

  it('matches case-insensitively + umlaut-normalized; preserves local original', () => {
    handle = seedDoc('Müller, mueller, MÜLLER')
    handle.setSelection(1, 7)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(3)
    const chips = handle.getChips()
    const originals = chips.map((c) => c.original).sort()
    expect(originals).toEqual(['MÜLLER', 'Müller', 'mueller'])
  })

  it('respects whole-word boundaries — "Bern" does not match inside "Berner"', () => {
    handle = seedDoc('Bern und Berner')
    handle.setSelection(1, 5)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'ORT', emptyMap())

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(1)
    expect(handle.getChips()).toHaveLength(1)
  })

  it('multi-word selection matches only the exact sequence', () => {
    handle = seedDoc('Anna Müller und Anna und Müller allein')
    handle.setSelection(1, 13)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(1)
  })

  it('overwrites existing chips of any type and reports their entityIds', () => {
    // Doc: chip("Zürich", NER), chip("Zürich", NER), text " ist zürich"
    // Selecting "zürich" in the text should overwrite both chips (umlaut-equivalent)
    handle = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Zürich'
              }
            },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Zürich'
              }
            },
            { type: 'text', text: ' ist zürich' }
          ]
        }
      ]
    })
    expect(handle.getChips()).toHaveLength(2)

    let zurichPos = -1
    handle.editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text!.includes('zürich')) {
        zurichPos = pos + node.text!.indexOf('zürich')
      }
    })
    expect(zurichPos).toBeGreaterThan(-1)
    handle.setSelection(zurichPos, zurichPos + 6)

    const map: EntityMap = {
      'person-1': { original: 'Zürich', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
    }
    const result = anonymizeSelectionWithPropagation(handle.editor, 'ORT', map)

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(3)
    expect(result!.overwrittenEntityIds.has('person-1')).toBe(true)

    const chipsAfter = handle.getChips()
    expect(chipsAfter).toHaveLength(3)
    expect(new Set(chipsAfter.map((c) => c.entityId)).size).toBe(1)
    expect(chipsAfter[0].entityId).toBe(result!.entityId)
    expect(chipsAfter[0].source).toBe('manual')
  })

  it('atomicity: a single Cmd+Z reverts all propagated chips (AK 5)', () => {
    handle = seedDoc('Müller war Müller und Müller.')
    handle.setSelection(1, 7)

    const result = anonymizeSelectionWithPropagation(handle.editor, 'PERSON', emptyMap())
    expect(result!.propagatedCount).toBe(3)
    expect(handle.getChips()).toHaveLength(3)

    handle.editor.commands.undo()

    expect(handle.getChips()).toHaveLength(0)
    expect(handle.editor.state.doc.textContent).toBe('Müller war Müller und Müller.')
  })

  it('reverse-sort correctness with mixed text + chip matches in same transaction', () => {
    handle = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bern und ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'ort-99',
                type: 'ORT',
                number: 99,
                source: 'ner',
                original: 'Bern'
              }
            },
            { type: 'text', text: ' und Bern' }
          ]
        }
      ]
    })

    handle.setSelection(1, 5) // first "Bern" text

    const map: EntityMap = {
      'ort-99': { original: 'Bern', placeholder: '[ORT 99]', type: 'ORT', source: 'ner' }
    }
    const result = anonymizeSelectionWithPropagation(handle.editor, 'ORT', map)

    expect(result).not.toBeNull()
    expect(result!.propagatedCount).toBe(3)
    const chips = handle.getChips()
    expect(chips).toHaveLength(3)
    expect(new Set(chips.map((c) => c.entityId)).size).toBe(1)
    expect(result!.overwrittenEntityIds.has('ort-99')).toBe(true)
  })
})

describe('rebuildEntityMapFromDoc', () => {
  it('returns null when no drift exists', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'manual',
      original: 'Anna'
    })
    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'manual' }
    }
    expect(rebuildEntityMapFromDoc(handle.editor.state.doc, map)).toBeNull()
  })

  it('returns null on an empty document', () => {
    handle = createTestEditor()
    expect(rebuildEntityMapFromDoc(handle.editor.state.doc, {})).toBeNull()
  })

  it('reconstructs entries from chip attributes preserving source', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'ner',
      original: 'Anna'
    })
    handle.insertChip(2, {
      entityId: 'ort-2',
      type: 'ORT',
      number: 2,
      source: 'blocklist',
      original: 'Bern'
    })
    handle.insertChip(3, {
      entityId: 'datum-3',
      type: 'DATUM',
      number: 3,
      source: 'manual',
      original: '01.01.2026'
    })

    const rebuilt = rebuildEntityMapFromDoc(handle.editor.state.doc, {})

    expect(rebuilt).not.toBeNull()
    expect(rebuilt!['person-1']).toMatchObject({
      original: 'Anna',
      placeholder: '[PERSON 1]',
      type: 'PERSON',
      source: 'ner'
    })
    expect(rebuilt!['ort-2'].source).toBe('blocklist')
    expect(rebuilt!['datum-3'].source).toBe('manual')
  })

  it('keeps existing entries untouched and only adds missing ones', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'ner',
      original: 'Anna'
    })
    handle.insertChip(2, {
      entityId: 'ort-2',
      type: 'ORT',
      number: 2,
      source: 'manual',
      original: 'Bern'
    })

    const map: EntityMap = {
      'person-1': {
        original: 'Anna Müller',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'ner'
      }
    }
    const rebuilt = rebuildEntityMapFromDoc(handle.editor.state.doc, map)

    expect(rebuilt).not.toBeNull()
    expect(rebuilt!['person-1'].original).toBe('Anna Müller')
    expect(rebuilt!['ort-2']).toMatchObject({ source: 'manual', original: 'Bern' })
  })
})

describe('addToBlocklistRetroactive (regression after Task 2 refactor)', () => {
  it('still returns null on empty selection', () => {
    handle = createTestEditor()
    const result = addToBlocklistRetroactive(handle.editor, 'foo', 'PERSON', emptyMap())
    expect(result).toBeNull()
  })

  it('replaces selection + retroactive matches in one transaction (one Cmd+Z reverts all)', () => {
    handle = seedDoc('Anna war Anna und Anna.')
    handle.setSelection(1, 5)

    const result = addToBlocklistRetroactive(handle.editor, 'Anna', 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    expect(handle.getChips()).toHaveLength(3)
    handle.editor.commands.undo()
    expect(handle.getChips()).toHaveLength(0)
    expect(handle.editor.state.doc.textContent).toBe('Anna war Anna und Anna.')
  })
})
