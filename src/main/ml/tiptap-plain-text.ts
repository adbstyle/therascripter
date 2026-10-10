import { tiptapToText } from '../../shared/utils/tiptapToText'

/**
 * LLM input: placeholders as `[TYPE NUMBER]`, no speaker labels/timestamps,
 * one trimmed line per non-empty paragraph. Takes unvalidated JSON straight
 * from disk.
 */
export function tiptapToPlainText(doc: unknown): string {
  return tiptapToText(doc, { includeSpeakers: false, includeTimestamps: false, compact: true })
}
