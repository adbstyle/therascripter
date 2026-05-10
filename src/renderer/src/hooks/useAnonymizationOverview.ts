import { useMemo } from 'react'
import type { Editor } from '@tiptap/core'
import type { PlaceholderType, EntitySource } from '../../../shared/types'
import { PLACEHOLDER_TYPE_ORDER, TYPE_LABELS } from '../constants/editorConstants'

export interface OriginalVariant {
  text: string
  count: number
  source: EntitySource
}

export interface AnonymizedIdentity {
  entityId: string
  type: PlaceholderType
  number: number
  placeholder: string
  variants: OriginalVariant[]
  totalCount: number
  /**
   * Longest variant by character length, ties broken by document order.
   * Used as the term when adding the identity to the Sperrliste — matches the
   * canonical-name choice in `coreference-resolver.ts` and minimises false
   * positives in the doc-wide retroactive scan.
   */
  canonicalVariant: OriginalVariant
}

export interface EntityTypeGroup {
  type: PlaceholderType
  label: string
  identities: AnonymizedIdentity[]
}

export interface AnonymizationOverviewData {
  groups: EntityTypeGroup[]
  totalIdentities: number
  totalChips: number
}

const EMPTY: AnonymizationOverviewData = { groups: [], totalIdentities: 0, totalChips: 0 }

export function useAnonymizationOverview(
  editor: Editor | null,
  updateCounter: number
): AnonymizationOverviewData {
  return useMemo(() => {
    if (!editor) return EMPTY

    const identityMap = new Map<
      string,
      {
        entityId: string
        type: PlaceholderType
        number: number
        variantMap: Map<string, { count: number; source: EntitySource; text: string }>
      }
    >()

    let totalChips = 0

    editor.state.doc.descendants((node) => {
      if (node.type.name !== 'placeholderChip') return
      totalChips++

      const { entityId, type, number, source, original } = node.attrs as {
        entityId: string
        type: PlaceholderType
        number: number
        source: EntitySource
        original: string
      }

      let entry = identityMap.get(entityId)
      if (!entry) {
        entry = { entityId, type, number, variantMap: new Map() }
        identityMap.set(entityId, entry)
      }

      const variantKey = `${original}\0${source}`
      const variant = entry.variantMap.get(variantKey)
      if (variant) {
        variant.count++
      } else {
        entry.variantMap.set(variantKey, { count: 1, source, text: original })
      }
    })

    if (totalChips === 0) return EMPTY

    const groupMap = new Map<PlaceholderType, AnonymizedIdentity[]>()

    for (const entry of identityMap.values()) {
      const variants: OriginalVariant[] = []
      for (const { text, count, source } of entry.variantMap.values()) {
        variants.push({ text, count, source })
      }

      let canonicalVariant = variants[0]
      for (let i = 1; i < variants.length; i++) {
        if (variants[i].text.length > canonicalVariant.text.length) {
          canonicalVariant = variants[i]
        }
      }

      const identity: AnonymizedIdentity = {
        entityId: entry.entityId,
        type: entry.type,
        number: entry.number,
        placeholder: `[${entry.type} ${entry.number}]`,
        variants,
        totalCount: variants.reduce((sum, v) => sum + v.count, 0),
        canonicalVariant
      }

      const existing = groupMap.get(entry.type)
      if (existing) {
        existing.push(identity)
      } else {
        groupMap.set(entry.type, [identity])
      }
    }

    const groups: EntityTypeGroup[] = []
    for (const type of PLACEHOLDER_TYPE_ORDER) {
      const identities = groupMap.get(type)
      if (identities && identities.length > 0) {
        identities.sort((a, b) => a.number - b.number)
        groups.push({ type, label: TYPE_LABELS[type], identities })
      }
    }

    return {
      groups,
      totalIdentities: identityMap.size,
      totalChips
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, updateCounter])
}
