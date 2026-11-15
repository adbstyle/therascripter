/**
 * Serialize a TipTap document to plain text for clipboard export.
 * Used by the Review Editor export-to-clipboard feature (US-7).
 *
 * Audio sessions: includes speaker labels + timestamps.
 * PDF sessions: plain text with placeholders only (no labels/timestamps).
 * View mode (Issue #203): pseudonymized → placeholder tokens; plain → the
 * originals the chips replace (token where no original is stored).
 */
import type { SessionType, TipTapDocument } from '../types'
import type { ViewMode } from '../types/ViewMode'
import { tiptapToText } from './tiptapToText'

export function serializeDocument(
  doc: TipTapDocument,
  sessionType: SessionType,
  viewMode: ViewMode = 'pseudonymized'
): string {
  const isAudio = sessionType === 'audio'
  return tiptapToText(doc, {
    includeSpeakers: isAudio,
    includeTimestamps: isAudio,
    compact: false,
    chips: viewMode === 'plain' ? 'original' : 'token'
  })
}
