import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeStitchMap, stitchPcmSegments } from '../AudioStitchService'
import { createWavHeader } from '../AudioFileService'
import type { SpeakerSegment } from '../../../shared/types'

const SAMPLE_RATE = 48000
const BYTES_PER_SAMPLE = 2

/** 48 kHz mono s16le WAV, deren Sample-Werte ihrem Sample-Index entsprechen
 *  (mod 32768) — macht Byte-Offset-Fehler im Stitcher sofort sichtbar. */
function makeIndexedWav(path: string, durationSec: number): void {
  const sampleCount = Math.round(durationSec * SAMPLE_RATE)
  const pcm = Buffer.alloc(sampleCount * BYTES_PER_SAMPLE)
  for (let i = 0; i < sampleCount; i++) {
    pcm.writeInt16LE(i % 32768, i * BYTES_PER_SAMPLE)
  }
  writeFileSync(path, Buffer.concat([createWavHeader(pcm.length), pcm]))
}

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

describe('stitchPcmSegments', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stitch-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('concatenates the exact PCM byte ranges of the source', async () => {
    const src = join(dir, 'src.wav')
    makeIndexedWav(src, 2) // 2 s, Samples 0..95999
    const map = computeStitchMap(
      [
        { label: 'A', start: 0.5, end: 0.75 },
        { label: 'B', start: 1.5, end: 1.75 }
      ],
      0, // kein Padding → exakte Grenzen
      2
    )
    const out = join(dir, 'out.wav')

    await stitchPcmSegments(src, map, out)

    const content = readFileSync(out)
    const expectedSamples = 0.5 * SAMPLE_RATE // 2 Segmente à 0.25 s
    expect(content.length).toBe(44 + expectedSamples * BYTES_PER_SAMPLE)
    // Header: dataSize + RIFF-Size korrekt
    expect(content.readUInt32LE(40)).toBe(expectedSamples * BYTES_PER_SAMPLE)
    expect(content.readUInt32LE(4)).toBe(36 + expectedSamples * BYTES_PER_SAMPLE)
    // Erster Sample des ersten Segments = Sample-Index 0.5*48000 = 24000
    expect(content.readInt16LE(44)).toBe(24000)
    // Erster Sample des zweiten Segments = Index 1.5*48000 = 72000 (mod 32768)
    const seg2Offset = 44 + 0.25 * SAMPLE_RATE * BYTES_PER_SAMPLE
    expect(content.readInt16LE(seg2Offset)).toBe(72000 % 32768)
    // Letzter Sample insgesamt = Index 1.75*48000 - 1 = 83999 (mod 32768)
    expect(content.readInt16LE(content.length - 2)).toBe(83999 % 32768)
  })

  it('clamps segment ends beyond the actual file size', async () => {
    const src = join(dir, 'src.wav')
    makeIndexedWav(src, 1)
    // originalDuration behauptet 2 s, Datei hat nur 1 s → Ende clampen
    const map = computeStitchMap([{ label: 'A', start: 0.5, end: 1.9 }], 0, 2)
    const out = join(dir, 'out.wav')

    await stitchPcmSegments(src, map, out)

    const content = readFileSync(out)
    expect(content.length).toBe(44 + 0.5 * SAMPLE_RATE * BYTES_PER_SAMPLE)
  })

  it('respects an already-aborted signal', async () => {
    const src = join(dir, 'src.wav')
    makeIndexedWav(src, 1)
    const map = computeStitchMap([{ label: 'A', start: 0, end: 1 }], 0, 1)
    const controller = new AbortController()
    controller.abort()

    await expect(
      stitchPcmSegments(src, map, join(dir, 'out.wav'), controller.signal)
    ).rejects.toThrow(/abgebrochen/i)
  })

  it('handles hundreds of segments without resource exhaustion (EMFILE-Regression)', async () => {
    const src = join(dir, 'src.wav')
    makeIndexedWav(src, 10)
    const speech: SpeakerSegment[] = []
    for (let i = 0; i < 400; i++) {
      speech.push({ label: 'A', start: i * 0.025, end: i * 0.025 + 0.01 })
    }
    const map = computeStitchMap(speech, 0, 10)
    const out = join(dir, 'out.wav')

    await stitchPcmSegments(src, map, out)

    const content = readFileSync(out)
    const expectedBytes = map.segments.reduce(
      (sum, s) => sum + Math.round((s.originalEnd - s.originalStart) * SAMPLE_RATE) * 2,
      0
    )
    expect(content.length).toBe(44 + expectedBytes)
  })
})
