import { describe, it, expect } from 'vitest'
import { getNextNumber } from '../editorCommands'
import type { EntityMap } from '../../../../shared/types'

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
