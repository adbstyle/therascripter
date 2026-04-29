/**
 * One contiguous segment in the stitched WAV.
 * `originalStart` / `originalEnd` map the segment back to the source audio's
 * wall-clock time. `stitchedStart` is the cumulative offset within the stitched WAV.
 */
export interface StitchSegment {
  originalStart: number // seconds in source audio
  originalEnd: number // seconds in source audio
  stitchedStart: number // seconds in stitched WAV
  duration: number // = originalEnd - originalStart (same in both timelines)
}

export interface StitchMap {
  segments: StitchSegment[]
  paddingSec: number // padding applied around each speech segment (e.g. 0.2)
  stitchedDurationSec: number // total length of stitched WAV
  originalDurationSec: number // total length of source audio
}
