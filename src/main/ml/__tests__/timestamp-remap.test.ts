import { describe, it, expect } from 'vitest'
import { remapStitchedTimestamp } from '../timestamp-remap'
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
