/**
 * Serialize a TipTap document to plain text for clipboard export.
 * Used by the Review Editor export-to-clipboard feature (US-7).
 *
 * Audio sessions: includes speaker labels + timestamps.
 * PDF sessions: plain text with placeholders only (no labels/timestamps).
 */
import type { SessionType, TipTapDocument } from '../types'
import { tiptapToText } from './tiptapToText'

export function serializeDocument(doc: TipTapDocument, sessionType: SessionType): string {
  const isAudio = sessionType === 'audio'
  return tiptapToText(doc, {
    includeSpeakers: isAudio,
    includeTimestamps: isAudio,
    compact: false
  })
}
