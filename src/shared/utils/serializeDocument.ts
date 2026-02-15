/**
 * Serialize a TipTap document to plain text for clipboard export.
 * Used by the Review Editor export-to-clipboard feature (US-7).
 *
 * Audio sessions: includes speaker labels + timestamps.
 * PDF sessions: plain text with placeholders only (no labels/timestamps).
 */
import type { SessionType, TipTapDocument, TipTapInlineNode } from '../types'

export function serializeDocument(doc: TipTapDocument, sessionType: SessionType): string {
  const paragraphs: string[] = []

  for (const paragraph of doc.content) {
    if (paragraph.type !== 'paragraph') continue

    let line = ''
    const nodes: TipTapInlineNode[] = paragraph.content ?? []

    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          line += node.text
          break
        case 'placeholderChip':
          line += `[${node.attrs.type} ${node.attrs.number}]`
          break
        case 'speakerLabel':
          if (sessionType === 'audio') {
            line += `[${node.attrs.label}]:`
          }
          break
        case 'timestamp':
          if (sessionType === 'audio') {
            line += `[${node.attrs.formatted}]`
          }
          break
      }
    }

    paragraphs.push(line)
  }

  return paragraphs.join('\n').trim()
}
