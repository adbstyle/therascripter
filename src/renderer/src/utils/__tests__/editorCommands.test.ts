import { describe, it, expect, afterEach, vi } from 'vitest'
import * as editorCommandsModule from '../editorCommands'
import {
  getNextNumber,
  anonymizeSelectionWithPropagation,
  reconcileEntityMapWithDoc,
  addToBlocklistRetroactive,
  addToBlocklistFromTerm,
  changeChipTypeForEntity
} from '../editorCommands'
import type { EntityMap } from '../../../../shared/types'
import { createTestEditor, type TestEditorHandle } from '../../../../test-support/createTestEditor'

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

describe('reconcileEntityMapWithDoc', () => {
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
    expect(reconcileEntityMapWithDoc(handle.editor.state.doc, map)).toBeNull()
  })

  it('returns null on empty doc + empty map', () => {
    handle = createTestEditor()
    expect(reconcileEntityMapWithDoc(handle.editor.state.doc, {})).toBeNull()
  })

  it('add direction — empty map, doc with chip reconstructs entry', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-1',
      type: 'PERSON',
      number: 1,
      source: 'ner',
      original: 'Anna'
    })

    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, {})

    expect(result).not.toBeNull()
    expect(result!['person-1']).toMatchObject({
      original: 'Anna',
      placeholder: '[PERSON 1]',
      type: 'PERSON',
      source: 'ner'
    })
  })

  it('remove direction — empty doc, map with entry returns map without orphan', () => {
    handle = createTestEditor()
    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'manual' }
    }

    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, map)

    expect(result).not.toBeNull()
    expect(result).toEqual({})
  })

  it('mixed — adds and removes in one call', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: 'person-2',
      type: 'PERSON',
      number: 2,
      source: 'manual',
      original: 'Bern'
    })

    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'manual' }
    }
    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, map)

    expect(result).not.toBeNull()
    expect(result!['person-1']).toBeUndefined()
    expect(result!['person-2']).toMatchObject({
      original: 'Bern',
      placeholder: '[PERSON 2]',
      type: 'PERSON',
      source: 'manual'
    })
  })

  it('preserves chip-level source for ner / blocklist / manual', () => {
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

    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, {})

    expect(result).not.toBeNull()
    expect(result!['person-1'].source).toBe('ner')
    expect(result!['ort-2'].source).toBe('blocklist')
    expect(result!['datum-3'].source).toBe('manual')
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
    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, map)

    expect(result).not.toBeNull()
    expect(result!['person-1'].original).toBe('Anna Müller')
    expect(result!['ort-2']).toMatchObject({ source: 'manual', original: 'Bern' })
  })

  it('skips chips with empty entityId without crashing', () => {
    handle = createTestEditor()
    handle.insertChip(1, {
      entityId: '',
      type: 'PERSON',
      number: 1,
      source: 'manual',
      original: 'Anna'
    })

    const result = reconcileEntityMapWithDoc(handle.editor.state.doc, {})

    expect(result).toBeNull()
  })

  it('end-to-end: anonymize overwrite + undo + reconcile prunes orphan and restores entry', () => {
    // Doc: "Bern ist " + chip("Bern", person-3, NER) + " schön".
    // Selecting the leading text "Bern" propagates to the chip via Pass B,
    // which overwrites person-3 with the new ORT entityId.
    handle = createTestEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bern ist ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-3',
                type: 'PERSON',
                number: 3,
                source: 'ner',
                original: 'Bern'
              }
            },
            { type: 'text', text: ' schön' }
          ]
        }
      ]
    })
    let entityMap: EntityMap = {
      'person-3': { original: 'Bern', placeholder: '[PERSON 3]', type: 'PERSON', source: 'ner' }
    }

    handle.setSelection(1, 5) // select leading "Bern" text

    const result = anonymizeSelectionWithPropagation(handle.editor, 'ORT', entityMap)
    expect(result).not.toBeNull()
    expect(result!.overwrittenEntityIds.has('person-3')).toBe(true)
    const newId = result!.entityId

    // Caller-side orphan cleanup (matches ReviewEditor.handleAnonymize)
    entityMap = { ...result!.entityMap }
    for (const oldId of result!.overwrittenEntityIds) {
      let stillPresent = false
      handle.editor.state.doc.descendants((n) => {
        if (n.type.name === 'placeholderChip' && n.attrs.entityId === oldId) {
          stillPresent = true
        }
      })
      if (!stillPresent) delete entityMap[oldId]
    }
    expect(entityMap['person-3']).toBeUndefined()
    expect(entityMap[newId]).toBeDefined()

    handle.editor.commands.undo()

    const reconciled = reconcileEntityMapWithDoc(handle.editor.state.doc, entityMap)

    expect(reconciled).not.toBeNull()
    expect(reconciled![newId]).toBeUndefined()
    expect(reconciled!['person-3']).toMatchObject({
      placeholder: '[PERSON 3]',
      type: 'PERSON',
      source: 'ner',
      original: 'Bern'
    })
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

describe('addToBlocklistFromTerm (chip-flow, no selection)', () => {
  it('returns null when term is empty/whitespace', () => {
    handle = seedDoc('Anna war hier.')
    expect(addToBlocklistFromTerm(handle.editor, '   ', 'PERSON', emptyMap())).toBeNull()
  })

  it('returns null when term has no occurrences in the doc', () => {
    handle = seedDoc('Anna war hier.')
    expect(addToBlocklistFromTerm(handle.editor, 'Bert', 'PERSON', emptyMap())).toBeNull()
  })

  it('replaces all text occurrences of term in one transaction', () => {
    handle = seedDoc('Anna und Anna trafen Anna.')
    const result = addToBlocklistFromTerm(handle.editor, 'Anna', 'PERSON', emptyMap())

    expect(result).not.toBeNull()
    const chips = handle.getChips()
    expect(chips).toHaveLength(3)
    expect(chips.every((c) => c.entityId === result!.entityId)).toBe(true)
    expect(chips.every((c) => c.source === 'blocklist')).toBe(true)
    expect(result!.entityMap[result!.entityId]).toMatchObject({
      placeholder: '[PERSON 1]',
      type: 'PERSON',
      source: 'blocklist',
      original: 'Anna'
    })

    handle.editor.commands.undo()
    expect(handle.getChips()).toHaveLength(0)
  })

  it('overwrites existing chips matching the term (overwritesChips: true)', () => {
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
                original: 'Anna'
              }
            },
            { type: 'text', text: ' und Anna' }
          ]
        }
      ]
    })

    const result = addToBlocklistFromTerm(handle.editor, 'Anna', 'PERSON', {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
    })

    expect(result).not.toBeNull()
    const chips = handle.getChips()
    expect(chips).toHaveLength(2)
    expect(chips.every((c) => c.entityId === result!.entityId)).toBe(true)
    expect(chips.every((c) => c.source === 'blocklist')).toBe(true)
  })

  it('respects whole-word boundary (Bern not inside Berner)', () => {
    handle = seedDoc('Bern und Berner.')
    const result = addToBlocklistFromTerm(handle.editor, 'Bern', 'ORT', emptyMap())

    expect(result).not.toBeNull()
    expect(handle.getChips()).toHaveLength(1)
  })
})

describe('changeChipTypeForEntity', () => {
  it('returns null when no chip with the entityId exists', () => {
    handle = seedDoc('Anna war hier.')
    expect(changeChipTypeForEntity(handle.editor, 'person-99', 'ORT', emptyMap())).toBeNull()
  })

  it('returns null when newType equals current type (silent no-op)', () => {
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
    expect(changeChipTypeForEntity(handle.editor, 'person-1', 'PERSON', map)).toBeNull()
    expect(handle.getChips()).toHaveLength(1)
    expect(handle.getChips()[0].type).toBe('PERSON')
  })

  it('rewrites every chip with entityId under a new entityId of newType', () => {
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
                original: 'Bern'
              }
            },
            { type: 'text', text: ' war ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Bern'
              }
            }
          ]
        }
      ]
    })

    const map: EntityMap = {
      'person-1': { original: 'Bern', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
    }
    const result = changeChipTypeForEntity(handle.editor, 'person-1', 'ORT', map)

    expect(result).not.toBeNull()
    expect(result!.rewrittenCount).toBe(2)
    expect(result!.entityId).toBe('ort-1')

    const chips = handle.getChips()
    expect(chips).toHaveLength(2)
    expect(chips.every((c) => c.type === 'ORT')).toBe(true)
    expect(chips.every((c) => c.entityId === 'ort-1')).toBe(true)
    expect(chips.every((c) => c.source === 'ner')).toBe(true)

    expect(result!.entityMap['ort-1']).toMatchObject({
      placeholder: '[ORT 1]',
      type: 'ORT',
      source: 'ner',
      original: 'Bern'
    })
    expect(result!.entityMap['person-1']).toBeUndefined()
  })

  it('does NOT touch other chips with a different entityId or text matches', () => {
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
                original: 'Anna'
              }
            },
            { type: 'text', text: ' und Anna und ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-2',
                type: 'PERSON',
                number: 2,
                source: 'ner',
                original: 'Anna'
              }
            }
          ]
        }
      ]
    })

    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' },
      'person-2': { original: 'Anna', placeholder: '[PERSON 2]', type: 'PERSON', source: 'ner' }
    }
    const result = changeChipTypeForEntity(handle.editor, 'person-1', 'ORT', map)

    expect(result).not.toBeNull()
    expect(result!.rewrittenCount).toBe(1)

    const chips = handle.getChips()
    expect(chips).toHaveLength(2)
    const ort = chips.filter((c) => c.type === 'ORT')
    const person = chips.filter((c) => c.type === 'PERSON')
    expect(ort).toHaveLength(1)
    expect(ort[0].entityId).toBe('ort-1')
    expect(person).toHaveLength(1)
    expect(person[0].entityId).toBe('person-2')
    expect(handle.editor.state.doc.textContent).toContain('Anna')
  })

  it('sourceOverride forces every rewritten chip to a single source', () => {
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
                source: 'blocklist',
                original: 'Anna'
              }
            },
            { type: 'text', text: ' x ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'blocklist',
                original: 'Anna'
              }
            }
          ]
        }
      ]
    })
    const map: EntityMap = {
      'person-1': {
        original: 'Anna',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'blocklist'
      }
    }
    const result = changeChipTypeForEntity(handle.editor, 'person-1', 'ORT', map, 'manual')

    expect(result).not.toBeNull()
    const chips = handle.getChips()
    expect(chips.every((c) => c.source === 'manual')).toBe(true)
    expect(result!.entityMap['ort-1']).toMatchObject({ source: 'manual' })
  })

  it('preserves source per-chip (e.g. blocklist chip stays blocklist)', () => {
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
                source: 'blocklist',
                original: 'Anna'
              }
            }
          ]
        }
      ]
    })
    const map: EntityMap = {
      'person-1': {
        original: 'Anna',
        placeholder: '[PERSON 1]',
        type: 'PERSON',
        source: 'blocklist'
      }
    }
    const result = changeChipTypeForEntity(handle.editor, 'person-1', 'ORT', map)

    expect(result).not.toBeNull()
    const chips = handle.getChips()
    expect(chips[0].source).toBe('blocklist')
    expect(result!.entityMap['ort-1']).toMatchObject({ source: 'blocklist' })
  })

  it('atomicity: a single Cmd+Z reverts every rewritten chip', () => {
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
                original: 'Anna'
              }
            },
            { type: 'text', text: ' x ' },
            {
              type: 'placeholderChip',
              attrs: {
                entityId: 'person-1',
                type: 'PERSON',
                number: 1,
                source: 'ner',
                original: 'Anna'
              }
            }
          ]
        }
      ]
    })
    const map: EntityMap = {
      'person-1': { original: 'Anna', placeholder: '[PERSON 1]', type: 'PERSON', source: 'ner' }
    }
    changeChipTypeForEntity(handle.editor, 'person-1', 'ORT', map)
    expect(handle.getChips().every((c) => c.type === 'ORT')).toBe(true)

    handle.editor.commands.undo()
    expect(handle.getChips().every((c) => c.type === 'PERSON')).toBe(true)
  })
})

describe('reconcile keystroke gate (mirrors ReviewEditor handleKeyDown)', () => {
  // Mirrors the gate at ReviewEditor.tsx — covers Cmd+Z, Cmd+Shift+Z, Cmd+Y.
  // Calls the imported reconcileEntityMapWithDoc through the module namespace
  // so vi.spyOn can intercept it.
  const buildHandleKeyDown =
    () =>
    (view: import('@tiptap/pm/view').EditorView, event: KeyboardEvent): boolean => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
        queueMicrotask(() => {
          editorCommandsModule.reconcileEntityMapWithDoc(view.state.doc, {})
        })
      }
      return false
    }

  const dispatchKey = (h: TestEditorHandle, init: KeyboardEventInit): void => {
    h.editor.view.someProp('handleKeyDown', (fn) => {
      fn(h.editor.view, new KeyboardEvent('keydown', init))
      return true
    })
  }

  const drainMicrotasks = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('helper called for Cmd+Z', async () => {
    const spy = vi.spyOn(editorCommandsModule, 'reconcileEntityMapWithDoc')
    handle = createTestEditor({ handleKeyDown: buildHandleKeyDown() })

    dispatchKey(handle, { metaKey: true, key: 'z' })
    await drainMicrotasks()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('helper called for Cmd+Shift+Z', async () => {
    const spy = vi.spyOn(editorCommandsModule, 'reconcileEntityMapWithDoc')
    handle = createTestEditor({ handleKeyDown: buildHandleKeyDown() })

    dispatchKey(handle, { metaKey: true, shiftKey: true, key: 'Z' })
    await drainMicrotasks()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('helper called for Cmd+Y (German QWERTZ redo)', async () => {
    const spy = vi.spyOn(editorCommandsModule, 'reconcileEntityMapWithDoc')
    handle = createTestEditor({ handleKeyDown: buildHandleKeyDown() })

    dispatchKey(handle, { metaKey: true, key: 'y' })
    await drainMicrotasks()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('helper NOT called for plain text typing', async () => {
    const spy = vi.spyOn(editorCommandsModule, 'reconcileEntityMapWithDoc')
    handle = createTestEditor({ handleKeyDown: buildHandleKeyDown() })

    for (let i = 0; i < 10; i++) {
      dispatchKey(handle, { key: 'x' })
    }
    await drainMicrotasks()

    expect(spy).not.toHaveBeenCalled()
  })

  it('helper NOT called for Cmd+S (or other modifier combos)', async () => {
    const spy = vi.spyOn(editorCommandsModule, 'reconcileEntityMapWithDoc')
    handle = createTestEditor({ handleKeyDown: buildHandleKeyDown() })

    dispatchKey(handle, { metaKey: true, key: 's' })
    dispatchKey(handle, { metaKey: true, key: 'a' })
    dispatchKey(handle, { ctrlKey: true, key: 'c' })
    await drainMicrotasks()

    expect(spy).not.toHaveBeenCalled()
  })
})
