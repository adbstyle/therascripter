import { describe, it, expect } from 'vitest'
import { parseRTTM, buildDiarizationData } from '../PyannoteSidecar'
import type { SpeakerSegment } from '../../../shared/types'

describe('parseRTTM', () => {
  it('parses valid RTTM lines', () => {
    const rttm = [
      'SPEAKER file1 1 0.50 1.20 <NA> <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 2.00 0.80 <NA> <NA> SPEAKER_01 <NA> <NA>',
      'SPEAKER file1 1 3.50 2.10 <NA> <NA> SPEAKER_00 <NA> <NA>'
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ label: 'SPEAKER_00', start: 0.5, end: 1.7 })
    expect(segments[1]).toEqual({ label: 'SPEAKER_01', start: 2.0, end: 2.8 })
    expect(segments[2]).toEqual({ label: 'SPEAKER_00', start: 3.5, end: 5.6 })
  })

  it('returns sorted segments by start time', () => {
    const rttm = [
      'SPEAKER file1 1 5.00 1.00 <NA> <NA> SPEAKER_01 <NA> <NA>',
      'SPEAKER file1 1 1.00 2.00 <NA> <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 3.00 1.50 <NA> <NA> SPEAKER_01 <NA> <NA>'
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments[0].start).toBe(1.0)
    expect(segments[1].start).toBe(3.0)
    expect(segments[2].start).toBe(5.0)
  })

  it('skips empty lines and non-SPEAKER lines', () => {
    const rttm = [
      '',
      '# comment line',
      'SPEAKER file1 1 0.50 1.20 <NA> <NA> SPEAKER_00 <NA> <NA>',
      '',
      'LEXEME file1 1 0.50 0.20 hello <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 2.00 0.80 <NA> <NA> SPEAKER_01 <NA> <NA>'
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(2)
  })

  it('skips lines with too few fields', () => {
    const rttm = [
      'SPEAKER file1 1 0.50 1.20 <NA> <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 0.50', // incomplete
      'SPEAKER file1 1 2.00 0.80 <NA> <NA> SPEAKER_01 <NA> <NA>'
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(2)
  })

  it('skips lines with NaN start or duration', () => {
    const rttm = [
      'SPEAKER file1 1 abc 1.20 <NA> <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 0.50 xyz <NA> <NA> SPEAKER_00 <NA> <NA>',
      'SPEAKER file1 1 2.00 0.80 <NA> <NA> SPEAKER_01 <NA> <NA>'
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(1)
    expect(segments[0].label).toBe('SPEAKER_01')
  })

  it('returns empty array for empty input', () => {
    expect(parseRTTM('')).toEqual([])
    expect(parseRTTM('\n\n')).toEqual([])
  })

  it('handles whitespace variations', () => {
    const rttm = '  SPEAKER  file1  1  0.50  1.20  <NA>  <NA>  SPEAKER_00  <NA>  <NA>  '

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ label: 'SPEAKER_00', start: 0.5, end: 1.7 })
  })

  it('filters out segments shorter than 0.5 seconds', () => {
    const rttm = [
      'SPEAKER file1 1 0.50 1.20 <NA> <NA> SPEAKER_00 <NA> <NA>', // 1.2s → kept
      'SPEAKER file1 1 2.00 0.10 <NA> <NA> SPEAKER_01 <NA> <NA>', // 0.1s → filtered
      'SPEAKER file1 1 3.00 0.49 <NA> <NA> SPEAKER_00 <NA> <NA>', // 0.49s → filtered
      'SPEAKER file1 1 4.00 0.50 <NA> <NA> SPEAKER_01 <NA> <NA>', // 0.5s → kept
      'SPEAKER file1 1 5.00 0.017 <NA> <NA> SPEAKER_00 <NA> <NA>' // 17ms → filtered
    ].join('\n')

    const segments = parseRTTM(rttm)

    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual({ label: 'SPEAKER_00', start: 0.5, end: 1.7 })
    expect(segments[1]).toEqual({ label: 'SPEAKER_01', start: 4.0, end: 4.5 })
  })
})

describe('buildDiarizationData', () => {
  it('builds correct data from segments', () => {
    const segments: SpeakerSegment[] = [
      { label: 'SPEAKER_00', start: 0, end: 5 },
      { label: 'SPEAKER_01', start: 5, end: 10 },
      { label: 'SPEAKER_00', start: 10, end: 15 }
    ]

    const result = buildDiarizationData(segments, 15, 'pyannote/speaker-diarization-3.1')

    expect(result.speakers).toBe(segments)
    expect(result.speakerCount).toBe(2)
    expect(result.metadata).toEqual({
      model: 'pyannote/speaker-diarization-3.1',
      duration: 15
    })
  })

  it('counts unique speakers correctly', () => {
    const segments: SpeakerSegment[] = [
      { label: 'A', start: 0, end: 1 },
      { label: 'B', start: 1, end: 2 },
      { label: 'C', start: 2, end: 3 },
      { label: 'A', start: 3, end: 4 }
    ]

    const result = buildDiarizationData(segments, 4, 'pyannote/speaker-diarization-3.1')

    expect(result.speakerCount).toBe(3)
  })

  it('handles single speaker', () => {
    const segments: SpeakerSegment[] = [{ label: 'SPEAKER_00', start: 0, end: 10 }]

    const result = buildDiarizationData(segments, 10, 'pyannote/speaker-diarization-3.1')

    expect(result.speakerCount).toBe(1)
  })

  it('handles empty segments', () => {
    const result = buildDiarizationData([], 0, 'pyannote/speaker-diarization-3.1')

    expect(result.speakers).toEqual([])
    expect(result.speakerCount).toBe(0)
  })
})
