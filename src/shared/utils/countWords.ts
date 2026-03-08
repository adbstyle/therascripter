import type { TipTapDocument } from '../types'

export function countWords(doc: TipTapDocument): number {
  let count = 0

  for (const paragraph of doc.content) {
    if (paragraph.type !== 'paragraph') continue
    for (const node of paragraph.content ?? []) {
      if (node.type === 'text') {
        count += node.text
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0).length
      } else if (node.type === 'placeholderChip') {
        count += 1
      }
    }
  }

  return count
}
