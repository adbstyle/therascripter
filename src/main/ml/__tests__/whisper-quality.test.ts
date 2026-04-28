import { describe, it, expect } from 'vitest'
import type { TranscriptSegment } from '../../../shared/types'
import {
  computeRepetitionRatio,
  classifyQuality,
  QualityRejectionError,
  REPETITION_WARN_THRESHOLD,
  REPETITION_REJECT_THRESHOLD,
  TRANSCRIPTION_PIPELINE_VERSION
} from '../whisper-quality'

function seg(text: string, start = 0, end = 1): TranscriptSegment {
  return { text, start, end }
}

describe('computeRepetitionRatio', () => {
  it('returns 0 for empty array', () => {
    expect(computeRepetitionRatio([])).toBe(0)
  })

  it('returns 0 for single segment', () => {
    expect(computeRepetitionRatio([seg('Hallo Welt.')])).toBe(0)
  })

  it('returns 0 for distinct adjacent segments', () => {
    expect(
      computeRepetitionRatio([seg('Erster Satz.'), seg('Zweiter Satz.'), seg('Dritter.')])
    ).toBe(0)
  })

  it('returns 1.0 when all adjacent pairs duplicate (full loop)', () => {
    const loop = Array.from({ length: 20 }, () => seg('Vielen Dank für das Gespräch.'))
    expect(computeRepetitionRatio(loop)).toBe(1)
  })

  it('mixed: 3 of 4 adjacent pairs duplicate → 0.75', () => {
    // A A A A B → pairs (A,A) (A,A) (A,A) (A,B) → 3/4
    const segments = [seg('A'), seg('A'), seg('A'), seg('A'), seg('B')]
    expect(computeRepetitionRatio(segments)).toBeCloseTo(0.75)
  })

  it('mixed: 2 of 4 adjacent pairs duplicate → 0.5', () => {
    // A A B B C → pairs (A,A) (A,B) (B,B) (B,C) → 2/4
    const segments = [seg('A'), seg('A'), seg('B'), seg('B'), seg('C')]
    expect(computeRepetitionRatio(segments)).toBeCloseTo(0.5)
  })

  it('non-adjacent repetitions do not count (ABAB pattern)', () => {
    // Same text repeated but never directly adjacent.
    const segments = [seg('A'), seg('B'), seg('A'), seg('B')]
    expect(computeRepetitionRatio(segments)).toBe(0)
  })

  it('whitespace and case differences are ignored', () => {
    const segments = [seg('  Hallo  Welt  '), seg('hallo welt')]
    expect(computeRepetitionRatio(segments)).toBe(1)
  })

  it('whitespace-only segments do not count as duplicates of each other', () => {
    // After normalization both become '' → length-0 guard skips them.
    const segments = [seg('   '), seg('   '), seg('   '), seg('echter Text')]
    expect(computeRepetitionRatio(segments)).toBe(0)
  })

  it('pairs containing an empty segment are excluded from the denominator', () => {
    // Real loop interleaved with silence segments: only (A,A) pairs are
    // counted, the (A,'')/('',A) pairs are skipped on both sides of the
    // ratio so the loop signal isn't diluted.
    const segments = [seg('A'), seg('A'), seg('   '), seg('A'), seg('A')]
    expect(computeRepetitionRatio(segments)).toBe(1)
  })
})

describe('classifyQuality', () => {
  it('returns null for sub-warning ratios', () => {
    expect(classifyQuality(0)).toBeNull()
    expect(classifyQuality(REPETITION_WARN_THRESHOLD)).toBeNull() // boundary: > strict
    expect(classifyQuality(0.29)).toBeNull()
  })

  it('returns repetition_warning above warn threshold', () => {
    expect(classifyQuality(0.31)).toBe('repetition_warning')
    expect(classifyQuality(0.5)).toBe('repetition_warning')
    expect(classifyQuality(REPETITION_REJECT_THRESHOLD)).toBe('repetition_warning') // boundary: > strict
  })

  it('returns rejected above reject threshold', () => {
    expect(classifyQuality(0.71)).toBe('rejected')
    expect(classifyQuality(0.95)).toBe('rejected')
    expect(classifyQuality(1)).toBe('rejected')
  })
})

describe('QualityRejectionError', () => {
  it('is an Error subclass with the ratio attached', () => {
    const err = new QualityRejectionError(0.85)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('QualityRejectionError')
    expect(err.ratio).toBe(0.85)
    expect(err.message).toContain('85')
  })

  it('survives instanceof checks across throw/catch', () => {
    try {
      throw new QualityRejectionError(0.9)
    } catch (e) {
      expect(e instanceof QualityRejectionError).toBe(true)
    }
  })
})

describe('TRANSCRIPTION_PIPELINE_VERSION', () => {
  it('is a positive integer', () => {
    expect(TRANSCRIPTION_PIPELINE_VERSION).toBeGreaterThan(0)
    expect(Number.isInteger(TRANSCRIPTION_PIPELINE_VERSION)).toBe(true)
  })
})
