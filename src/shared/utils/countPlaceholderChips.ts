import type { TipTapDocument } from '../types'

export function countPlaceholderChips(doc: TipTapDocument): number {
  let count = 0
  for (const paragraph of doc.content) {
    if (paragraph.type !== 'paragraph') continue
    for (const node of paragraph.content ?? []) {
      if (node.type === 'placeholderChip') count++
    }
  }
  return count
}
