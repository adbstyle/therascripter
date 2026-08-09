import { describe, it, expect } from 'vitest'
import { remapStitchedTimestamp, remapStitchedWordInterval } from '../timestamp-remap'
import type { StitchMap } from '../../../shared/types'

const fixture: StitchMap = {
  paddingSec: 0,
  originalDurationSec: 100,
  stitchedDurationSec: 30,
  segments: [
    // Original 10–20s → stitched 0–10s
    { originalStart: 10, originalEnd: 20, stitchedStart: 0, duration: 10 },
    // Original 50–60s → stitched 10–20s
    { originalStart: 50, originalEnd: 60, stitchedStart: 10, duration: 10 },
    // Original 80–90s → stitched 20–30s
    { originalStart: 80, originalEnd: 90, stitchedStart: 20, duration: 10 }
  ]
}

describe('remapStitchedTimestamp', () => {
  it('maps stitched 0 to original 10 (start of first segment)', () => {
    expect(remapStitchedTimestamp(0, fixture)).toBe(10)
  })

  it('maps stitched 5 to original 15 (middle of first segment)', () => {
    expect(remapStitchedTimestamp(5, fixture)).toBe(15)
  })

  it('maps stitched 10 to original 50 (boundary jumps to second segment)', () => {
    expect(remapStitchedTimestamp(10, fixture)).toBe(50)
  })

  it('maps stitched 15 to original 55 (middle of second segment)', () => {
    expect(remapStitchedTimestamp(15, fixture)).toBe(55)
  })

  it('maps stitched 25 to original 85 (middle of third segment)', () => {
    expect(remapStitchedTimestamp(25, fixture)).toBe(85)
  })

  it('clamps stitched timestamp at end-of-stitched-audio to last segment end', () => {
    expect(remapStitchedTimestamp(30, fixture)).toBe(90)
  })

  it('clamps overshoot to last segment end (whisper sometimes reports past end)', () => {
    expect(remapStitchedTimestamp(35, fixture)).toBe(90)
  })

  it('returns first segment start for negative stitched timestamps (defensive)', () => {
    expect(remapStitchedTimestamp(-1, fixture)).toBe(10)
  })

  it('returns 0 for empty stitch map', () => {
    const emptyMap: StitchMap = {
      paddingSec: 0,
      originalDurationSec: 100,
      stitchedDurationSec: 0,
      segments: []
    }
    expect(remapStitchedTimestamp(5, emptyMap)).toBe(0)
  })
})

describe('remapStitchedWordInterval', () => {
  it('maps interval fully inside one segment identically to scalar remap', () => {
    const result = remapStitchedWordInterval(4, 5, fixture)

    expect(result.start).toBe(14)
    expect(result.end).toBe(15)
  })

  it('clamps boundary-spanning interval into the segment with the larger overlap (second)', () => {
    // Stitched [9.8, 10.5] spans the seam at 10: overlap seg0 = 0.2, seg1 = 0.5
    const result = remapStitchedWordInterval(9.8, 10.5, fixture)

    // Entire interval clamped into seg1 (orig 50–60) — no elided silence injected
    expect(result.start).toBe(50)
    expect(result.end).toBeCloseTo(50.5, 10)
    expect(result.end - result.start).toBeLessThanOrEqual(10.5 - 9.8)
  })

  it('clamps boundary-spanning interval into the segment with the larger overlap (first)', () => {
    // Stitched [9.5, 10.2]: overlap seg0 = 0.5, seg1 = 0.2
    const result = remapStitchedWordInterval(9.5, 10.2, fixture)

    expect(result.start).toBeCloseTo(19.5, 10)
    expect(result.end).toBe(20)
  })

  it('resolves overlap ties to the earlier segment', () => {
    // Stitched [9.75, 10.25]: overlap seg0 = 0.25, seg1 = 0.25 → earlier segment wins
    const result = remapStitchedWordInterval(9.75, 10.25, fixture)

    expect(result.start).toBeCloseTo(19.75, 10)
    expect(result.end).toBe(20)
  })

  it('falls back to scalar remap when interval overlaps no segment', () => {
    // Past end of stitched audio → scalar behavior clamps both to last segment end
    const result = remapStitchedWordInterval(31, 32, fixture)

    expect(result.start).toBe(90)
    expect(result.end).toBe(90)
  })

  it('falls back to scalar remap for empty stitch map', () => {
    const emptyMap: StitchMap = {
      paddingSec: 0,
      originalDurationSec: 100,
      stitchedDurationSec: 0,
      segments: []
    }

    expect(remapStitchedWordInterval(5, 6, emptyMap)).toEqual({ start: 0, end: 0 })
  })

  it('regression: word "Juli" spanning the seam is not inflated by elided silence (session e18cabcc)', () => {
    // Real numbers: seam at stitched 35.483, 0.343 s of original audio elided.
    // Old behavior mapped [35.38, 35.66] → [36.510, 37.133] (0.28 s word → 0.62 s).
    const realMap: StitchMap = {
      paddingSec: 0.2,
      originalDurationSec: 189.3,
      stitchedDurationSec: 183.517,
      segments: [
        { originalStart: 1.13, originalEnd: 36.613, stitchedStart: 0, duration: 35.483 },
        { originalStart: 36.956, originalEnd: 179.916, stitchedStart: 35.483, duration: 142.96 }
      ]
    }

    const result = remapStitchedWordInterval(35.38, 35.66, realMap)

    // Larger overlap lies in segment 2 (0.177 s vs 0.103 s) → clamp into it
    expect(result.start).toBe(36.956)
    expect(result.end).toBeCloseTo(37.133, 10)
    // Duration must not exceed the stitched word duration (0.28 s)
    expect(result.end - result.start).toBeLessThanOrEqual(35.66 - 35.38)
  })
})
