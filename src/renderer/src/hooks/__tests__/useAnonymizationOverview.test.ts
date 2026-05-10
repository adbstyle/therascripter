import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAnonymizationOverview } from '../useAnonymizationOverview'
import type { PlaceholderType, EntitySource } from '../../../../shared/types'

interface ChipAttrs {
  entityId: string
  type: PlaceholderType
  number: number
  source: EntitySource
  original: string
}

function createMockEditor(chips: ChipAttrs[]) {
  return {
    state: {
      doc: {
        descendants: (callback: (node: { type: { name: string }; attrs: ChipAttrs }) => void) => {
          for (const attrs of chips) {
            callback({ type: { name: 'placeholderChip' }, attrs })
          }
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('useAnonymizationOverview', () => {
  it('returns empty data when editor is null', () => {
    const { result } = renderHook(() => useAnonymizationOverview(null, 0))

    expect(result.current).toEqual({ groups: [], totalIdentities: 0, totalChips: 0 })
  })

  it('returns empty data when document has no chips', () => {
    const editor = createMockEditor([])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    expect(result.current).toEqual({ groups: [], totalIdentities: 0, totalChips: 0 })
  })

  it('returns a single identity for a single chip', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max Muster' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    expect(result.current.totalChips).toBe(1)
    expect(result.current.totalIdentities).toBe(1)
    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups[0].type).toBe('PERSON')
    expect(result.current.groups[0].identities).toHaveLength(1)
    expect(result.current.groups[0].identities[0].placeholder).toBe('[PERSON 1]')
    expect(result.current.groups[0].identities[0].variants).toEqual([
      { text: 'Max Muster', count: 1, source: 'ner' }
    ])
  })

  it('groups multiple chips with same entityId into one identity', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max Muster' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max Muster' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Herr Muster' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    expect(result.current.totalChips).toBe(3)
    expect(result.current.totalIdentities).toBe(1)

    const identity = result.current.groups[0].identities[0]
    expect(identity.totalCount).toBe(3)
    expect(identity.variants).toHaveLength(2)

    const maxVariant = identity.variants.find((v) => v.text === 'Max Muster')
    expect(maxVariant?.count).toBe(2)

    const herrVariant = identity.variants.find((v) => v.text === 'Herr Muster')
    expect(herrVariant?.count).toBe(1)
  })

  it('keeps same original with different sources as separate variants', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max Muster' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'blocklist', original: 'Max Muster' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.variants).toHaveLength(2)
    expect(identity.variants.find((v) => v.source === 'ner')).toBeDefined()
    expect(identity.variants.find((v) => v.source === 'blocklist')).toBeDefined()
  })

  it('groups by type in canonical order (PERSON before ORT before DATUM)', () => {
    const editor = createMockEditor([
      { entityId: 'd1', type: 'DATUM', number: 1, source: 'ner', original: '01.01.2025' },
      { entityId: 'o1', type: 'ORT', number: 1, source: 'ner', original: 'Zürich' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max Muster' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    expect(result.current.groups).toHaveLength(3)
    expect(result.current.groups[0].type).toBe('PERSON')
    expect(result.current.groups[1].type).toBe('ORT')
    expect(result.current.groups[2].type).toBe('DATUM')
  })

  it('sorts identities within a group by number', () => {
    const editor = createMockEditor([
      { entityId: 'p3', type: 'PERSON', number: 3, source: 'ner', original: 'C' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'A' },
      { entityId: 'p2', type: 'PERSON', number: 2, source: 'ner', original: 'B' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identities = result.current.groups[0].identities
    expect(identities[0].number).toBe(1)
    expect(identities[1].number).toBe(2)
    expect(identities[2].number).toBe(3)
  })

  it('filters out types with no chips', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Max' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups[0].type).toBe('PERSON')
  })

  it('attaches the longest variant as canonicalVariant', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Müller' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Hans Müller' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Hans' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.canonicalVariant.text).toBe('Hans Müller')
  })

  it('canonicalVariant for a single-variant identity is that variant', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Anna' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.canonicalVariant).toEqual({ text: 'Anna', count: 1, source: 'ner' })
  })

  it('marks pure-NER identity as not allVariantsBlocklisted', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Anna' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Anna Müller' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.allVariantsBlocklisted).toBe(false)
    expect(identity.canonicalNonBlocklistVariant?.text).toBe('Anna Müller')
  })

  it('marks pure-blocklist identity as allVariantsBlocklisted', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'blocklist', original: 'Anna' },
      {
        entityId: 'p1',
        type: 'PERSON',
        number: 1,
        source: 'blocklist',
        original: 'Anna Müller'
      }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.allVariantsBlocklisted).toBe(true)
    expect(identity.canonicalNonBlocklistVariant).toBeNull()
  })

  it('mixed-source: canonicalVariant picks longest overall, canonicalNonBlocklistVariant skips blocklist', () => {
    const editor = createMockEditor([
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Müller' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'blocklist', original: 'Hans Müller' },
      { entityId: 'p1', type: 'PERSON', number: 1, source: 'ner', original: 'Hans' }
    ])
    const { result } = renderHook(() => useAnonymizationOverview(editor, 0))

    const identity = result.current.groups[0].identities[0]
    expect(identity.allVariantsBlocklisted).toBe(false)
    expect(identity.canonicalVariant.text).toBe('Hans Müller')
    expect(identity.canonicalNonBlocklistVariant?.text).toBe('Müller')
  })

  it('recomputes when updateCounter changes', () => {
    const chips = [
      { entityId: 'p1', type: 'PERSON' as PlaceholderType, number: 1, source: 'ner' as EntitySource, original: 'Max' }
    ]
    const editor = createMockEditor(chips)
    const { result, rerender } = renderHook(
      ({ counter }) => useAnonymizationOverview(editor, counter),
      { initialProps: { counter: 0 } }
    )

    const first = result.current
    rerender({ counter: 1 })
    const second = result.current

    // Should recompute (new object reference) even with same data
    expect(first).not.toBe(second)
    expect(second.totalChips).toBe(1)
  })
})
