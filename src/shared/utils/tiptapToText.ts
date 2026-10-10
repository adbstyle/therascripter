/**
 * Plain-text rendering of a TipTap transcript document — the one walker
 * behind every text output: clipboard export (`serializeDocument`), LLM input
 * (`tiptapToPlainText`) and, per paragraph, the editor's Cmd+C
 * (`serializeClipboardText`). Node formats live only here, so the outputs
 * cannot drift apart again (PR #134: chips rendered as '' in one of them).
 *
 * Tolerant against unvalidated JSON (persisted documents, `editor.getJSON()`):
 * never throws; missing text counts as '', chips without type/number and
 * meta nodes without label/formatted are dropped, `content` that is not an
 * array counts as empty, unknown nodes contribute the text of their children
 * (nested blocks keep their paragraphs; a hardBreak has none and vanishes).
 */
import type { PlaceholderType } from '../types'
import { formatPlaceholderToken } from './formatPlaceholderToken'

export interface TipTapTextOptions {
  /** Speaker labels as `[Person A]:` — otherwise dropped. */
  includeSpeakers: boolean
  /** Timestamps as `[HH:MM:SS]` — otherwise dropped. */
  includeTimestamps: boolean
  /**
   * true: trim every paragraph and drop empty ones (dense LLM input; the trim
   * also removes the ' ' spacers tiptap-builder puts around speaker/timestamp
   * nodes). false: paragraphs verbatim, blank lines kept, only the ends of the
   * whole text trimmed (export — mirrors the editor layout).
   */
  compact: boolean
}

interface JsonNode {
  type?: unknown
  text?: unknown
  attrs?: unknown
  content?: unknown
}

function asNode(value: unknown): JsonNode | null {
  return typeof value === 'object' && value !== null ? (value as JsonNode) : null
}

function childrenOf(node: JsonNode): unknown[] {
  return Array.isArray(node.content) ? node.content : []
}

function walk(value: unknown, into: string[], options: TipTapTextOptions): void {
  const node = asNode(value)
  if (!node) return
  const attrs = (asNode(node.attrs) ?? {}) as Record<string, unknown>

  switch (node.type) {
    case 'text':
      into.push(typeof node.text === 'string' ? node.text : '')
      return
    case 'placeholderChip':
      // `!= null`: persistiertes JSON kennt kein undefined, wohl aber null.
      if (attrs.type != null && attrs.number != null) {
        into.push(
          formatPlaceholderToken({
            type: attrs.type as PlaceholderType,
            number: attrs.number as number
          })
        )
      }
      return
    case 'speakerLabel':
      if (options.includeSpeakers && attrs.label != null) into.push(`[${attrs.label}]:`)
      return
    case 'timestamp':
      if (options.includeTimestamps && attrs.formatted != null) into.push(`[${attrs.formatted}]`)
      return
    case 'paragraph':
      into.push(tiptapParagraphToText(node, options))
      return
    default:
      for (const child of childrenOf(node)) walk(child, into, options)
  }
}

/** Text of a single paragraph node (trimmed only when `compact`). */
export function tiptapParagraphToText(paragraph: unknown, options: TipTapTextOptions): string {
  const node = asNode(paragraph)
  const buf: string[] = []
  for (const child of node ? childrenOf(node) : []) walk(child, buf, options)
  const text = buf.join('')
  return options.compact ? text.trim() : text
}

/** Text of a whole document, one line per paragraph. */
export function tiptapToText(doc: unknown, options: TipTapTextOptions): string {
  const lines: string[] = []
  walk(doc, lines, options)
  return options.compact
    ? lines.filter((line) => line.length > 0).join('\n')
    : lines.join('\n').trim()
}
