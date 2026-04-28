import type { TranscriptSegment, QualityFlag } from '../../shared/types'

// ADR-006 thresholds. Strict greater-than comparisons.
// Both severities are non-blocking: the pipeline runs to completion either
// way, the only effect is a banner the user sees in the review editor.
export const REPETITION_WARN_THRESHOLD = 0.3
export const REPETITION_CRITICAL_THRESHOLD = 0.7

export type QualityClassification = QualityFlag | null

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Counts adjacent identical segments (whitespace-normalized, case-insensitive).
 * Returns ratio = adjacent-duplicate-pairs / non-empty-pairs.
 *
 * Pairs where either side is empty/whitespace-only are excluded from both
 * sides of the ratio so a loop interleaved with silence segments isn't
 * artificially diluted by the empty pairs in the denominator.
 *
 * Detects whisper hallucination loops: when the model rolls over its previous
 * window's output as prompt context and reproduces the same sentence per
 * 30s window, every adjacent pair of segments becomes identical.
 */
export function computeRepetitionRatio(segments: TranscriptSegment[]): number {
  if (segments.length < 2) return 0

  let totalPairs = 0
  let duplicatePairs = 0

  for (let i = 1; i < segments.length; i++) {
    const prev = normalize(segments[i - 1].text)
    const curr = normalize(segments[i].text)
    if (prev.length === 0 || curr.length === 0) continue
    totalPairs++
    if (prev === curr) duplicatePairs++
  }

  return totalPairs === 0 ? 0 : duplicatePairs / totalPairs
}

/**
 * Classifies a repetition ratio per ADR-006 thresholds.
 * - ratio > 0.7 → 'repetition_critical' (strong banner, likely unusable)
 * - ratio > 0.3 → 'repetition_warning' (soft banner, prüfen)
 * - else → null (no issue)
 *
 * Both severities are non-blocking; the pipeline always continues so the
 * user can inspect the result and decide whether to record again or report
 * a bug with the actual broken transcript attached.
 */
export function classifyQuality(ratio: number): QualityClassification {
  if (ratio > REPETITION_CRITICAL_THRESHOLD) return 'repetition_critical'
  if (ratio > REPETITION_WARN_THRESHOLD) return 'repetition_warning'
  return null
}
