import { describe, it, expect } from 'vitest'
import { computeStitchMap, buildFfmpegArgs } from '../AudioStitchService'
import type { SpeakerSegment, StitchMap } from '../../../shared/types'

describe('computeStitchMap', () => {
  it('returns empty map for empty input', () => {
    const map = computeStitchMap([], 0.2, 100)
    expect(map.segments).toEqual([])
    expect(map.stitchedDurationSec).toBe(0)
    expect(map.originalDurationSec).toBe(100)
  })

  it('applies symmetric padding around a single segment', () => {
    const speech: SpeakerSegment[] = [{ label: 'A', start: 10, end: 20 }]
    const map = computeStitchMap(speech, 0.2, 100)
    expect(map.segments).toHaveLength(1)
    expect(map.segments[0].originalStart).toBeCloseTo(9.8, 5)
    expect(map.segments[0].originalEnd).toBeCloseTo(20.2, 5)
    expect(map.segments[0].stitchedStart).toBe(0)
    expect(map.segments[0].duration).toBeCloseTo(10.4, 5)
    expect(map.stitchedDurationSec).toBeCloseTo(10.4, 5)
  })

  it('clamps padding at audio boundaries', () => {
    const speech: SpeakerSegment[] = [
      { label: 'A', start: 0.1, end: 5 },
      { label: 'A', start: 95, end: 99.95 }
    ]
    const map = computeStitchMap(speech, 0.2, 100)
    // First segment: padded start clamped to 0
    expect(map.segments[0].originalStart).toBe(0)
    expect(map.segments[0].originalEnd).toBeCloseTo(5.2, 5)
    // Last segment: padded end clamped to 100
    expect(map.segments[1].originalEnd).toBe(100)
  })

  it('merges overlapping padded segments', () => {
    // Two segments 0.3s apart with 0.2s padding each → combined padding 0.4s > gap 0.3s → merge
    const speech: SpeakerSegment[] = [
      { label: 'A', start: 10, end: 15 },
      { label: 'B', start: 15.3, end: 20 }
    ]
    const map = computeStitchMap(speech, 0.2, 100)
    // Merged into single block 9.8–20.2
    expect(map.segments).toHaveLength(1)
    expect(map.segments[0].originalStart).toBeCloseTo(9.8, 5)
    expect(map.segments[0].originalEnd).toBeCloseTo(20.2, 5)
  })

  it('keeps non-overlapping padded segments separate', () => {
    const speech: SpeakerSegment[] = [
      { label: 'A', start: 10, end: 15 },
      { label: 'B', start: 30, end: 35 }
    ]
    const map = computeStitchMap(speech, 0.2, 100)
    expect(map.segments).toHaveLength(2)
    expect(map.segments[0].originalStart).toBeCloseTo(9.8, 5)
    expect(map.segments[0].originalEnd).toBeCloseTo(15.2, 5)
    expect(map.segments[0].stitchedStart).toBe(0)
    expect(map.segments[0].duration).toBeCloseTo(5.4, 5)
    expect(map.segments[1].originalStart).toBeCloseTo(29.8, 5)
    expect(map.segments[1].originalEnd).toBeCloseTo(35.2, 5)
    expect(map.segments[1].stitchedStart).toBeCloseTo(5.4, 5)
    expect(map.segments[1].duration).toBeCloseTo(5.4, 5)
    expect(map.stitchedDurationSec).toBeCloseTo(10.8, 5)
  })

  it('sorts unsorted input by start time', () => {
    const speech: SpeakerSegment[] = [
      { label: 'B', start: 30, end: 35 },
      { label: 'A', start: 10, end: 15 }
    ]
    const map = computeStitchMap(speech, 0.2, 100)
    expect(map.segments[0].originalStart).toBeCloseTo(9.8, 5) // first by time, not input order
  })
})

describe('buildFfmpegArgs', () => {
  it('builds concat-demuxer args with one -ss/-to/-i per segment', () => {
    const map: StitchMap = {
      paddingSec: 0.2,
      originalDurationSec: 100,
      stitchedDurationSec: 10,
      segments: [
        { originalStart: 10, originalEnd: 15, stitchedStart: 0, duration: 5 },
        { originalStart: 20, originalEnd: 25, stitchedStart: 5, duration: 5 }
      ]
    }
    const args = buildFfmpegArgs('/audio.wav', map, '/out.wav')

    // Two -ss values, two -to values
    const ssIndices = args.flatMap((a, i) => (a === '-ss' ? [i] : []))
    expect(ssIndices).toHaveLength(2)
    const toIndices = args.flatMap((a, i) => (a === '-to' ? [i] : []))
    expect(toIndices).toHaveLength(2)

    // Filter complex with concat=n=2
    expect(args.some((a) => a.includes('concat=n=2:v=0:a=1'))).toBe(true)
    // Output codec
    expect(args).toContain('pcm_s16le')
    expect(args[args.length - 1]).toBe('/out.wav')
  })
})
