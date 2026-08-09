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

/**
 * Map a word's [start, end] interval from the stitched timeline back to the
 * original timeline as a unit. Remapping start and end independently through
 * remapStitchedTimestamp injects the elided silence into the middle of any
 * word that spans a stitch seam (e.g. a 0.28 s word inflated to 0.62 s) —
 * with long elided pauses the inflated interval can overlap an arbitrarily
 * wrong diarization turn downstream.
 *
 * A word is atomic continuous speech, so it cannot genuinely contain elided
 * silence: pick the stitch segment with the greatest overlap (ties → earlier
 * segment) and clamp the whole interval into it. The result always lies
 * within ONE original segment and never exceeds the stitched duration.
 * Degenerate inputs (empty map, no overlap) fall back to scalar remapping.
 */
export function remapStitchedWordInterval(
  start: number,
  end: number,
  map: StitchMap
): { start: number; end: number } {
  let bestSeg: StitchMap['segments'][number] | null = null
  let bestOverlap = 0

  for (const seg of map.segments) {
    const stitchedEnd = seg.stitchedStart + seg.duration
    const overlap = Math.min(end, stitchedEnd) - Math.max(start, seg.stitchedStart)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestSeg = seg
    }
  }

  if (!bestSeg) {
    return {
      start: remapStitchedTimestamp(start, map),
      end: remapStitchedTimestamp(end, map)
    }
  }

  const stitchedEnd = bestSeg.stitchedStart + bestSeg.duration
  const clampedStart = Math.max(start, bestSeg.stitchedStart)
  const clampedEnd = Math.min(end, stitchedEnd)

  return {
    start: bestSeg.originalStart + (clampedStart - bestSeg.stitchedStart),
    end: bestSeg.originalStart + (clampedEnd - bestSeg.stitchedStart)
  }
}
