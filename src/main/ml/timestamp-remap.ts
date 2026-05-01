import type { StitchMap } from '../../shared/types'

/**
 * Map a timestamp from the stitched WAV's timeline back to the original
 * audio's wall-clock timeline. Used to translate whisper-cli output (which
 * runs against the stitched WAV) into timestamps usable by the alignment
 * service (which works against the original audio's diarization).
 *
 * Boundary behavior:
 * - Stitched timestamp at exactly a segment boundary maps to the START of
 *   the next segment (jump over the elided silence).
 * - Stitched timestamp before 0 → start of first segment (defensive).
 * - Stitched timestamp at or beyond stitchedDuration → end of last segment.
 * - Empty map → 0 (no segments to map against).
 */
export function remapStitchedTimestamp(stitched: number, map: StitchMap): number {
  if (map.segments.length === 0) return 0

  if (stitched <= 0) return map.segments[0].originalStart

  // Walk segments; first segment whose stitchedStart + duration > stitched contains the timestamp
  for (const seg of map.segments) {
    const stitchedEnd = seg.stitchedStart + seg.duration
    if (stitched < stitchedEnd) {
      // Linear within segment
      const offsetInSegment = stitched - seg.stitchedStart
      return seg.originalStart + offsetInSegment
    }
  }

  // Past last segment: clamp to last segment end
  const last = map.segments[map.segments.length - 1]
  return last.originalEnd
}
