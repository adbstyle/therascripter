import { describe, it, expect } from 'vitest'
import {
  buildSpeakerLabelMap,
  alignWords,
  findSpeakerForTime,
  rebuildSegmentsWithSpeakers,
  formatTimestamp
} from '../AlignmentService'
import type { TranscriptWord, SpeakerSegment } from '../../../shared/types'

// --- Test helpers ---

function word(text: string, start: number, end: number, speaker?: string): TranscriptWord {
  return { text, start, end, speaker }
}

function seg(label: string, start: number, end: number): SpeakerSegment {
  return { label, start, end }
}

// --- buildSpeakerLabelMap ---

describe('buildSpeakerLabelMap', () => {
  it('maps speakers in order of first appearance', () => {
    const segments = [seg('SPEAKER_02', 0, 5), seg('SPEAKER_00', 5, 10), seg('SPEAKER_02', 10, 15)]

    const map = buildSpeakerLabelMap(segments)

    expect(map.get('SPEAKER_02')).toBe('A')
    expect(map.get('SPEAKER_00')).toBe('B')
    expect(map.size).toBe(2)
  })

  it('handles single speaker', () => {
    const segments = [seg('SPEAKER_00', 0, 10)]

    const map = buildSpeakerLabelMap(segments)

    expect(map.get('SPEAKER_00')).toBe('A')
    expect(map.size).toBe(1)
  })

  it('handles many speakers beyond predefined labels', () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(`SPK_${i}`, i * 10, (i + 1) * 10))

    const map = buildSpeakerLabelMap(segments)

    expect(map.get('SPK_0')).toBe('A')
    expect(map.get('SPK_7')).toBe('H')
    // Beyond 8 predefined labels, uses String.fromCharCode fallback
    expect(map.get('SPK_8')).toBe('I')
    expect(map.get('SPK_9')).toBe('J')
  })

  it('returns empty map for empty segments', () => {
    const map = buildSpeakerLabelMap([])

    expect(map.size).toBe(0)
  })

  it('sorts by start time before assigning labels', () => {
    // Segments out of order — should still assign A to earliest
    const segments = [seg('SPEAKER_01', 10, 15), seg('SPEAKER_00', 0, 5)]

    const map = buildSpeakerLabelMap(segments)

    expect(map.get('SPEAKER_00')).toBe('A')
    expect(map.get('SPEAKER_01')).toBe('B')
  })
})

// --- findSpeakerForTime ---

describe('findSpeakerForTime', () => {
  const segments = [seg('A', 0, 5), seg('B', 5, 10), seg('A', 12, 18)]

  it('returns segment containing the time point', () => {
    expect(findSpeakerForTime(2.5, segments)).toEqual(seg('A', 0, 5))
    expect(findSpeakerForTime(7.0, segments)).toEqual(seg('B', 5, 10))
    expect(findSpeakerForTime(15.0, segments)).toEqual(seg('A', 12, 18))
  })

  it('returns segment at exact start boundary', () => {
    expect(findSpeakerForTime(0, segments)).toEqual(seg('A', 0, 5))
    expect(findSpeakerForTime(5, segments)).toEqual(seg('B', 5, 10))
  })

  it('falls back to nearest segment for gaps', () => {
    // Time 11 falls in gap between B (5-10) and A (12-18)
    // Nearest is A (dist to 12 = 1) vs B (dist to 10 = 1), B also has dist to 5 = 6
    // B end is at 10, dist = 1; A start is at 12, dist = 1
    // Both have dist = 1, first match wins (B)
    const result = findSpeakerForTime(11, segments)
    expect(result).not.toBeNull()
    // Either B or A is valid since equidistant — just verify we get a result
    expect(['A', 'B']).toContain(result!.label)
  })

  it('returns nearest for time before first segment', () => {
    const laterSegments = [seg('A', 5, 10)]
    const result = findSpeakerForTime(2, laterSegments)

    expect(result).toEqual(seg('A', 5, 10))
  })

  it('returns nearest for time after last segment', () => {
    const result = findSpeakerForTime(25, segments)

    expect(result).toEqual(seg('A', 12, 18))
  })

  it('returns null for empty segments', () => {
    expect(findSpeakerForTime(5, [])).toBeNull()
  })
})

// --- alignWords ---

describe('alignWords', () => {
  it('assigns speaker labels based on word midpoint', () => {
    const words = [
      word('Hallo', 0, 2), // midpoint 1 → in A (0-5)
      word('wie', 6, 8), // midpoint 7 → in B (5-10)
      word('gehts?', 13, 16) // midpoint 14.5 → in A (12-18)
    ]
    const speakers = [seg('SPEAKER_00', 0, 5), seg('SPEAKER_01', 5, 10), seg('SPEAKER_00', 12, 18)]
    const labelMap = new Map([
      ['SPEAKER_00', 'A'],
      ['SPEAKER_01', 'B']
    ])

    const result = alignWords(words, speakers, labelMap)

    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person B')
    expect(result[2].speaker).toBe('Person A')
  })

  it('preserves original word properties', () => {
    const words = [word('Test', 1, 3)]
    const speakers = [seg('SPK', 0, 5)]
    const labelMap = new Map([['SPK', 'A']])

    const result = alignWords(words, speakers, labelMap)

    expect(result[0].text).toBe('Test')
    expect(result[0].start).toBe(1)
    expect(result[0].end).toBe(3)
  })

  it('returns words unchanged when no speaker segments', () => {
    const words = [word('Hallo', 0, 2)]

    const result = alignWords(words, [], new Map())

    expect(result).toEqual(words)
  })

  it('handles words in gaps (nearest segment fallback)', () => {
    const words = [word('gap', 10.5, 11.5)] // midpoint 11, falls in gap
    const speakers = [seg('A', 0, 5), seg('B', 15, 20)]
    const labelMap = new Map([
      ['A', 'A'],
      ['B', 'B']
    ])

    const result = alignWords(words, speakers, labelMap)

    // Should get assigned to nearest segment
    expect(result[0].speaker).toBeDefined()
  })
})

// --- rebuildSegmentsWithSpeakers ---

describe('rebuildSegmentsWithSpeakers', () => {
  it('breaks segments at speaker changes', () => {
    const words = [
      word('Hallo.', 0, 1, 'Person A'),
      word('Hi.', 2, 3, 'Person B'),
      word('Tschüss.', 4, 5, 'Person A')
    ]

    const segments = rebuildSegmentsWithSpeakers(words, 2)

    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ text: 'Hallo.', start: 0, end: 1, speaker: 'Person A' })
    expect(segments[1]).toEqual({ text: 'Hi.', start: 2, end: 3, speaker: 'Person B' })
    expect(segments[2]).toEqual({ text: 'Tschüss.', start: 4, end: 5, speaker: 'Person A' })
  })

  it('merges consecutive same-speaker words into one segment regardless of punctuation', () => {
    const words = [
      word('Hallo.', 0, 1, 'Person A'),
      word('Wie', 1, 2, 'Person A'),
      word('gehts?', 2, 3, 'Person A')
    ]

    const segments = rebuildSegmentsWithSpeakers(words, 2)

    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Hallo. Wie gehts?')
    expect(segments[0].speaker).toBe('Person A')
  })

  it('strips speaker labels for single speaker (speakerCount <= 1)', () => {
    const words = [word('Hallo.', 0, 1, 'Person A'), word('Tschüss.', 2, 3, 'Person A')]

    const segments = rebuildSegmentsWithSpeakers(words, 1)

    expect(segments).toHaveLength(2)
    expect(segments[0].speaker).toBeUndefined()
    expect(segments[1].speaker).toBeUndefined()
    expect(segments[0].text).toBe('Hallo.')
    expect(segments[1].text).toBe('Tschüss.')
  })

  it('also strips speaker labels when speakerCount is 0', () => {
    const words = [word('Solo.', 0, 1, 'Person A')]

    const segments = rebuildSegmentsWithSpeakers(words, 0)

    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBeUndefined()
  })

  it('returns empty array for empty words', () => {
    expect(rebuildSegmentsWithSpeakers([], 2)).toEqual([])
  })

  it('handles words without sentence-ending punctuation', () => {
    const words = [word('Hallo', 0, 1, 'Person A'), word('Welt', 1, 2, 'Person A')]

    const segments = rebuildSegmentsWithSpeakers(words, 2)

    // All words in one segment (no punctuation break, same speaker)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Hallo Welt')
    expect(segments[0].speaker).toBe('Person A')
  })

  it('handles consecutive speaker changes without punctuation', () => {
    const words = [
      word('Ja', 0, 1, 'Person A'),
      word('Nein', 1, 2, 'Person B'),
      word('Doch', 2, 3, 'Person A')
    ]

    const segments = rebuildSegmentsWithSpeakers(words, 2)

    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ text: 'Ja', start: 0, end: 1, speaker: 'Person A' })
    expect(segments[1]).toEqual({ text: 'Nein', start: 1, end: 2, speaker: 'Person B' })
    expect(segments[2]).toEqual({ text: 'Doch', start: 2, end: 3, speaker: 'Person A' })
  })

  it('correctly sets start/end from first/last word in segment', () => {
    const words = [
      word('Eins', 1.5, 2.0, 'Person A'),
      word('zwei', 2.0, 2.5, 'Person A'),
      word('drei.', 2.5, 3.0, 'Person A')
    ]

    const segments = rebuildSegmentsWithSpeakers(words, 2)

    expect(segments[0].start).toBe(1.5)
    expect(segments[0].end).toBe(3.0)
  })
})

// --- formatTimestamp ---

describe('formatTimestamp', () => {
  it('formats zero seconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00')
  })

  it('formats seconds only', () => {
    expect(formatTimestamp(45)).toBe('00:00:45')
  })

  it('formats minutes and seconds', () => {
    expect(formatTimestamp(125)).toBe('00:02:05')
  })

  it('formats hours, minutes, and seconds', () => {
    expect(formatTimestamp(3661)).toBe('01:01:01')
  })

  it('truncates fractional seconds (floors)', () => {
    expect(formatTimestamp(1.999)).toBe('00:00:01')
  })

  it('pads single digits with zeros', () => {
    expect(formatTimestamp(1)).toBe('00:00:01')
    expect(formatTimestamp(61)).toBe('00:01:01')
  })
})
