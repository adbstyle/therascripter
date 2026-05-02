import { describe, it, expect } from 'vitest'
import { sortByStatus } from '../ModelsSettings'
import type { ModelCatalogEntry } from '../../../../../shared/validation/model-catalog-schemas'

function entry(
  id: string,
  status: { isActive: boolean; isInstalled: boolean }
): ModelCatalogEntry {
  return {
    id,
    label: id,
    sizeBytes: 0,
    group: 'asr',
    isRequired: false,
    isActive: status.isActive,
    isInstalled: status.isInstalled
  }
}

describe('sortByStatus — Issue #84 Story E', () => {
  it('places the active model first, then installed, then missing', () => {
    const sorted = sortByStatus([
      entry('m-missing', { isActive: false, isInstalled: false }),
      entry('m-installed-1', { isActive: false, isInstalled: true }),
      entry('m-active', { isActive: true, isInstalled: true }),
      entry('m-installed-2', { isActive: false, isInstalled: true }),
      entry('m-missing-2', { isActive: false, isInstalled: false })
    ]).map((e) => e.id)

    expect(sorted).toEqual([
      'm-active',
      'm-installed-1',
      'm-installed-2',
      'm-missing',
      'm-missing-2'
    ])
  })

  it('preserves catalog order within each bucket (stable)', () => {
    const sorted = sortByStatus([
      entry('a-installed', { isActive: false, isInstalled: true }),
      entry('b-installed', { isActive: false, isInstalled: true }),
      entry('c-installed', { isActive: false, isInstalled: true })
    ]).map((e) => e.id)

    expect(sorted).toEqual(['a-installed', 'b-installed', 'c-installed'])
  })

  it('returns a new array (does not mutate input)', () => {
    const input = [
      entry('m-missing', { isActive: false, isInstalled: false }),
      entry('m-active', { isActive: true, isInstalled: true })
    ]
    const sorted = sortByStatus(input)
    expect(input.map((e) => e.id)).toEqual(['m-missing', 'm-active'])
    expect(sorted.map((e) => e.id)).toEqual(['m-active', 'm-missing'])
  })

  it('handles an empty list', () => {
    expect(sortByStatus([])).toEqual([])
  })
})
