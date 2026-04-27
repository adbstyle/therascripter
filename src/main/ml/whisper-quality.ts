import type { TranscriptSegment, QualityFlag } from '../../shared/types'

// Bumped whenever the whisper invocation or post-processing changes in a way
// that could give a different result for the same audio. The renderer offers a
// 'retry transcription' button only when a session's stored version is below
// this constant — otherwise the retry would be deterministic and useless.
//
// History:
// - v1: introduces -nc (--no-context) flag + repetition-ratio quality check (ADR-006)
export const TRANSCRIPTION_PIPELINE_VERSION = 1

// ADR-006 thresholds. Strict greater-than (matches issue #65 wording).
export const REPETITION_WARN_THRESHOLD = 0.3
export const REPETITION_REJECT_THRESHOLD = 0.7

export type QualityClassification = QualityFlag | 'rejected' | null

export class QualityRejectionError extends Error {
  readonly ratio: number
  constructor(ratio: number) {
    super(
      `Transkription wahrscheinlich fehlerhaft: ${(ratio * 100).toFixed(1)}% der Segmente sind direkte Wiederholungen.`
    )
    this.name = 'QualityRejectionError'
    this.ratio = ratio
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Counts adjacent identical segments (whitespace-normalized, case-insensitive).
 * Returns ratio = adjacent-duplicate-pairs / total-pairs, where total-pairs = segments.length - 1.
 *
 * Empty/whitespace-only segments do not count as duplicates of each other.
 *
 * Detects whisper hallucination loops: when the model rolls over its previous
 * window's output as prompt context and reproduces the same sentence per
 * 30s window, every adjacent pair of segments becomes identical.
 */
export function computeRepetitionRatio(segments: TranscriptSegment[]): number {
  if (segments.length < 2) return 0

  let duplicatePairs = 0
  let prev = normalize(segments[0].text)

  for (let i = 1; i < segments.length; i++) {
    const curr = normalize(segments[i].text)
    if (curr.length > 0 && curr === prev) duplicatePairs++
    prev = curr
  }

  return duplicatePairs / (segments.length - 1)
}

/**
 * Classifies a repetition ratio per ADR-006 thresholds.
 * - ratio > 0.7 → 'rejected' (transcript should be marked transcription_quality_failed)
 * - ratio > 0.3 → 'repetition_warning' (transcript still flows through pipeline, banner shown)
 * - else → null (no issue detected)
 */
export function classifyQuality(ratio: number): QualityClassification {
  if (ratio > REPETITION_REJECT_THRESHOLD) return 'rejected'
  if (ratio > REPETITION_WARN_THRESHOLD) return 'repetition_warning'
  return null
}
