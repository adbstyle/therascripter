import { describe, it, expect } from 'vitest'
import {
  buildSpeakerLabelMap,
  findBestOverlapSegment,
  alignWords,
  suppressSpeakerIslands,
  correctSentenceBoundaries,
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

// --- findBestOverlapSegment ---

describe('findBestOverlapSegment', () => {
  const segments = [seg('A', 0, 5), seg('B', 5, 10), seg('A', 12, 18)]

  it('returns segment with greatest overlap for word fully inside', () => {
    expect(findBestOverlapSegment(word('Hallo', 1, 3), segments)).toEqual(seg('A', 0, 5))
    expect(findBestOverlapSegment(word('Welt', 6, 8), segments)).toEqual(seg('B', 5, 10))
  })

  it('returns segment with greatest overlap when word straddles boundary', () => {
    // Word spans 4.8–5.2: overlap with A (0-5) = 0.2, overlap with B (5-10) = 0.2
    // Tie → first match (A) wins
    expect(findBestOverlapSegment(word('Ich', 4.8, 5.2), segments)).toEqual(seg('A', 0, 5))

    // Word spans 4.7–5.3: overlap with A = 0.3, overlap with B = 0.3 → tie → A
    expect(findBestOverlapSegment(word('Ich', 4.7, 5.3), segments)).toEqual(seg('A', 0, 5))

    // Word spans 4.6–5.4: overlap with A = 0.4, overlap with B = 0.4 → tie → A
    expect(findBestOverlapSegment(word('Ich', 4.6, 5.4), segments)).toEqual(seg('A', 0, 5))

    // Word mostly in B: spans 4.9–5.5: overlap A = 0.1, overlap B = 0.5 → B wins
    expect(findBestOverlapSegment(word('Ich', 4.9, 5.5), segments)).toEqual(seg('B', 5, 10))
  })

  it('returns null when word falls in a gap (no overlap)', () => {
    // Word at 10.5–11.5 — gap between B (5-10) and A (12-18)
    expect(findBestOverlapSegment(word('gap', 10.5, 11.5), segments)).toBeNull()
  })

  it('returns null for empty segments', () => {
    expect(findBestOverlapSegment(word('test', 1, 2), [])).toBeNull()
  })

  it('handles overlapping speaker segments (picks larger overlap)', () => {
    // Two speakers overlap in time
    const overlapping = [seg('A', 0, 6), seg('B', 4, 10)]
    // Word at 4.5–5.5: overlap A = 1.0 (4.5→5.5 clipped to 4.5→6 = 1.5), overlap B = 1.0 (4.5→5.5 clipped to 4.5→5.5 = 1.0)
    // Actually: overlap A = min(5.5,6) - max(4.5,0) = 5.5-4.5 = 1.0
    // overlap B = min(5.5,10) - max(4.5,4) = 5.5-4.5 = 1.0 → tie → A
    expect(findBestOverlapSegment(word('overlap', 4.5, 5.5), overlapping)).toEqual(seg('A', 0, 6))

    // Word at 5.5–6.5: overlap A = min(6.5,6) - max(5.5,0) = 6-5.5 = 0.5
    // overlap B = min(6.5,10) - max(5.5,4) = 6.5-5.5 = 1.0 → B wins
    expect(findBestOverlapSegment(word('overlap', 5.5, 6.5), overlapping)).toEqual(seg('B', 4, 10))
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
  it('assigns speaker labels based on temporal overlap', () => {
    const words = [
      word('Hallo', 0, 2), // fully within A (0-5)
      word('wie', 6, 8), // fully within B (5-10)
      word('gehts?', 13, 16) // fully within A (12-18)
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
    const words = [word('gap', 10.5, 11.5)] // no overlap with any segment
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

// --- suppressSpeakerIslands ---

describe('suppressSpeakerIslands', () => {
  it('absorbs multi-word sandwich island ending mid-sentence', () => {
    // A ... [B B] ... A — island ends without .!? → diarization artifact
    const words = [
      word('und', 0, 0.5, 'Person A'),
      word('dann', 0.5, 1, 'Person A'),
      word('habe', 1, 1.5, 'Person B'),
      word('ich', 1.5, 2, 'Person B'),
      word('gedacht.', 2, 2.5, 'Person A')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result.map((w) => w.speaker)).toEqual([
      'Person A',
      'Person A',
      'Person A',
      'Person A',
      'Person A'
    ])
  })

  it('keeps single-word island (below MIN_ISLAND_WORDS)', () => {
    const words = [
      word('und', 0, 0.5, 'Person A'),
      word('vielleicht', 0.5, 1, 'Person B'),
      word('weiter', 1, 1.5, 'Person A')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result[1].speaker).toBe('Person B')
  })

  it('keeps island that ends at a sentence boundary (genuine interjection)', () => {
    const words = [
      word('und', 0, 0.5, 'Person A'),
      word('warte', 0.5, 1, 'Person B'),
      word('kurz.', 1, 1.5, 'Person B'),
      word('weiter', 1.5, 2, 'Person A')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result[1].speaker).toBe('Person B')
    expect(result[2].speaker).toBe('Person B')
  })

  it('keeps island longer than MAX_ISLAND_WORDS', () => {
    // 9-word island exceeds the 8-word cap → likely a genuine turn
    const island = Array.from({ length: 9 }, (_, i) =>
      word(`w${i}`, 1 + i * 0.3, 1.3 + i * 0.3, 'Person B')
    )
    const words = [word('vorher', 0, 1, 'Person A'), ...island, word('nachher', 4, 4.5, 'Person A')]

    const result = suppressSpeakerIslands(words)

    expect(result[1].speaker).toBe('Person B')
    expect(result[9].speaker).toBe('Person B')
  })

  it('keeps island exceeding MAX_ISLAND_DURATION_SEC', () => {
    // 2 words but 5 s span → likely a genuine turn
    const words = [
      word('vorher', 0, 1, 'Person A'),
      word('lange', 1, 3.5, 'Person B'),
      word('Pause', 5.5, 6, 'Person B'),
      word('nachher', 6, 6.5, 'Person A')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result[1].speaker).toBe('Person B')
    expect(result[2].speaker).toBe('Person B')
  })

  it('keeps non-sandwich run (different speakers on each side)', () => {
    const words = [
      word('eins', 0, 0.5, 'Person A'),
      word('zwei', 0.5, 1, 'Person B'),
      word('drei', 1, 1.5, 'Person B'),
      word('vier', 1.5, 2, 'Person C')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result[1].speaker).toBe('Person B')
    expect(result[2].speaker).toBe('Person B')
  })

  it('leaves runs at transcript start and end untouched (no sandwich possible)', () => {
    const words = [
      word('Anfang', 0, 0.5, 'Person B'),
      word('hier', 0.5, 1, 'Person B'),
      word('Mitte.', 1, 1.5, 'Person A'),
      word('Ende', 1.5, 2, 'Person B'),
      word('hier', 2, 2.5, 'Person B')
    ]

    const result = suppressSpeakerIslands(words)

    expect(result.map((w) => w.speaker)).toEqual([
      'Person B',
      'Person B',
      'Person A',
      'Person B',
      'Person B'
    ])
  })

  it('does not mutate input array', () => {
    const words = [
      word('und', 0, 0.5, 'Person A'),
      word('habe', 0.5, 1, 'Person B'),
      word('ich', 1, 1.5, 'Person B'),
      word('gedacht.', 1.5, 2, 'Person A')
    ]

    suppressSpeakerIslands(words)

    expect(words[1].speaker).toBe('Person B')
    expect(words[2].speaker).toBe('Person B')
  })

  it('returns input unchanged for fewer than 3 words', () => {
    const words = [word('Hallo', 0, 1, 'Person A'), word('Welt', 1, 2, 'Person B')]

    expect(suppressSpeakerIslands(words)).toEqual(words)
  })

  it('regression: phantom pyannote island splits sentence across speakers (session e18cabcc)', () => {
    // Real data: pyannote emitted a spurious 2.14 s SPEAKER_01 turn inside a
    // continuous SPEAKER_03 utterance. The full chain must yield ONE segment.
    const speakers = [
      seg('SPEAKER_03', 26.963, 36.413),
      seg('SPEAKER_01', 37.156, 39.299), // phantom island — sole occurrence in the file
      seg('SPEAKER_03', 39.248, 60.342)
    ]
    const words = [
      word('sind.', 35.65, 36.23),
      word('Im', 36.23, 36.4),
      word('Juli', 36.51, 37.133), // zero overlap with any turn (stitch-padding band)
      word('etwa', 37.133, 37.513),
      word('wurden', 37.513, 38.083),
      word('unter', 38.083, 38.553),
      word('anderem', 38.623, 39.203),
      word('zwei', 39.203, 39.593),
      word('Schweizer', 39.593, 40.03)
    ]
    const labelMap = buildSpeakerLabelMap(speakers)

    const aligned = alignWords(words, speakers, labelMap)
    // Precondition (documents the bug): raw alignment produces the island
    expect(aligned[2].speaker).toBe('Person B')
    expect(aligned[6].speaker).toBe('Person B')

    const corrected = correctSentenceBoundaries(suppressSpeakerIslands(aligned))
    const segments = rebuildSegmentsWithSpeakers(corrected, 4)

    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBe('Person A')
    expect(segments[0].text).toBe('sind. Im Juli etwa wurden unter anderem zwei Schweizer')
  })
})

// --- correctSentenceBoundaries ---

describe('correctSentenceBoundaries', () => {
  it('snaps single-word speaker change to sentence boundary (Bug 1 original)', () => {
    // "sagen." (A) → "Ich" (A, should be B) → "denke" (B)
    const words = [
      word('sagen.', 0, 1, 'Person A'),
      word('Ich', 1, 2, 'Person A'),
      word('denke', 2, 3, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person B') // reassigned
    expect(result[2].speaker).toBe('Person B')
  })

  it('snaps multi-word speaker change to sentence boundary (Bug 1 real data)', () => {
    // "beklagen." (A) → "Es" (A) "ist" (A) "ein" (A) → "Leitsatz" (B)
    // All of "Es ist ein" should become B
    const words = [
      word('beklagen.', 22, 23, 'Person A'),
      word('Es', 23, 23.2, 'Person A'),
      word('ist', 23.2, 23.5, 'Person A'),
      word('ein', 23.5, 23.8, 'Person A'),
      word('Leitsatz,', 23.8, 24.5, 'Person B'),
      word('den', 24.5, 25, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    expect(result[0].speaker).toBe('Person A') // "beklagen." stays A
    expect(result[1].speaker).toBe('Person B') // "Es" → B
    expect(result[2].speaker).toBe('Person B') // "ist" → B
    expect(result[3].speaker).toBe('Person B') // "ein" → B
    expect(result[4].speaker).toBe('Person B')
    expect(result[5].speaker).toBe('Person B')
  })

  it('snaps trailing words to sentence boundary (Bug 2 real data)', () => {
    // "klicken?" (B) → "Eigentlich" (B) "niemandem," (B) → "eigentlich" (A)
    // "Eigentlich niemandem," should become A
    const words = [
      word('klicken?', 33, 34, 'Person B'),
      word('Eigentlich', 34, 35, 'Person B'),
      word('niemandem,', 35, 35.5, 'Person B'),
      word('eigentlich', 35.5, 36, 'Person A'),
      word('niemandem.', 36, 37, 'Person A')
    ]

    const result = correctSentenceBoundaries(words)

    expect(result[0].speaker).toBe('Person B') // "klicken?" stays B
    expect(result[1].speaker).toBe('Person A') // "Eigentlich" → A
    expect(result[2].speaker).toBe('Person A') // "niemandem," → A
    expect(result[3].speaker).toBe('Person A')
    expect(result[4].speaker).toBe('Person A')
  })

  it('handles multiple corrections in one pass', () => {
    const words = [
      word('ja.', 0, 1, 'Person A'),
      word('Ich', 1, 2, 'Person A'), // should be C
      word('bin', 2, 3, 'Person C'),
      word('durch.', 3, 4, 'Person C'),
      word('Ich', 4, 5, 'Person C'), // should be A
      word('würde', 5, 6, 'Person A')
    ]

    const result = correctSentenceBoundaries(words)

    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person C') // fixed
    expect(result[2].speaker).toBe('Person C')
    expect(result[3].speaker).toBe('Person C')
    expect(result[4].speaker).toBe('Person A') // fixed
    expect(result[5].speaker).toBe('Person A')
  })

  it('does not snap when change is already at sentence boundary', () => {
    const words = [
      word('Ende.', 0, 1, 'Person A'),
      word('Anfang', 1, 2, 'Person B'),
      word('weiter', 2, 3, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    // Change is already at "Ende." boundary — no modification
    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person B')
  })

  it('does not snap when no sentence boundary within lookback', () => {
    // 6 words without punctuation before speaker change → exceeds MAX_SENTENCE_LOOKBACK (5)
    const words = [
      word('und', 0, 1, 'Person A'),
      word('dann', 1, 2, 'Person A'),
      word('hat', 2, 3, 'Person A'),
      word('er', 3, 4, 'Person A'),
      word('auch', 4, 5, 'Person A'),
      word('noch', 5, 6, 'Person A'),
      word('gesagt', 6, 7, 'Person A'),
      word('dass', 7, 8, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    // No sentence end within 5 words lookback from "dass" → no snap
    expect(result[6].speaker).toBe('Person A')
    expect(result[7].speaker).toBe('Person B')
  })

  it('does not snap when lookback crosses different speakers', () => {
    // Words between sentence end and speaker change have mixed speakers
    const words = [
      word('gut.', 0, 1, 'Person A'),
      word('Und', 1, 2, 'Person A'),
      word('ja', 2, 3, 'Person B'), // different speaker in between
      word('genau', 3, 4, 'Person A'),
      word('also', 4, 5, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    // All words should remain unchanged — mixed speakers prevent any snap
    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person A') // must NOT be snapped to B
    expect(result[2].speaker).toBe('Person B')
    expect(result[3].speaker).toBe('Person A')
    expect(result[4].speaker).toBe('Person B')
  })

  it('does not snap isolated speaker blip (A-B-A pattern)', () => {
    // Single B word surrounded by A — should not trigger a snap
    const words = [
      word('Ende.', 0, 1, 'Person A'),
      word('Und', 1, 2, 'Person A'),
      word('ja', 2, 3, 'Person B'), // isolated blip
      word('genau', 3, 4, 'Person A'),
      word('weiter', 4, 5, 'Person A')
    ]

    const result = correctSentenceBoundaries(words)

    // "ja" is an isolated B word — forward-look safety prevents snap
    expect(result[1].speaker).toBe('Person A') // unchanged
    expect(result[2].speaker).toBe('Person B') // unchanged
    expect(result[3].speaker).toBe('Person A') // unchanged
  })

  it('does not snap after comma (only .!?)', () => {
    const words = [
      word('also,', 0, 1, 'Person A'),
      word('Ich', 1, 2, 'Person A'),
      word('denke', 2, 3, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    // "also," ends with comma, not .!? — no snap
    expect(result[1].speaker).toBe('Person A')
  })

  it('does not mutate input array', () => {
    const words = [
      word('Ende.', 0, 1, 'Person A'),
      word('Anfang', 1, 2, 'Person A'),
      word('weiter', 2, 3, 'Person B')
    ]
    const originalSpeaker = words[1].speaker

    correctSentenceBoundaries(words)

    expect(words[1].speaker).toBe(originalSpeaker)
  })

  it('returns input unchanged for fewer than 2 words', () => {
    expect(correctSentenceBoundaries([word('Solo', 0, 1, 'Person A')])).toEqual([
      word('Solo', 0, 1, 'Person A')
    ])
    expect(correctSentenceBoundaries([])).toEqual([])
  })

  it('handles exclamation and question marks', () => {
    const words = [
      word('Nein!', 0, 1, 'Person A'),
      word('Doch', 1, 2, 'Person A'),
      word('also', 2, 3, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    expect(result[1].speaker).toBe('Person B') // snapped to after "Nein!"
  })

  it('handles speaker change at first word (no lookback possible)', () => {
    const words = [word('Hallo', 0, 1, 'Person A'), word('Welt', 1, 2, 'Person B')]

    const result = correctSentenceBoundaries(words)

    // No sentence boundary before first word — no snap
    expect(result[0].speaker).toBe('Person A')
    expect(result[1].speaker).toBe('Person B')
  })

  it('snaps exactly at MAX_SENTENCE_LOOKBACK boundary (5 words)', () => {
    // Sentence end is exactly 5 words before the speaker change
    const words = [
      word('Ende.', 0, 1, 'Person A'),
      word('w1', 1, 2, 'Person A'),
      word('w2', 2, 3, 'Person A'),
      word('w3', 3, 4, 'Person A'),
      word('w4', 4, 5, 'Person A'),
      word('w5', 5, 6, 'Person A'),
      word('Neu', 6, 7, 'Person B')
    ]

    const result = correctSentenceBoundaries(words)

    // "Ende." is 5 words before "Neu" → within MAX_SENTENCE_LOOKBACK → snap
    expect(result[1].speaker).toBe('Person B') // w1 → B
    expect(result[5].speaker).toBe('Person B') // w5 → B
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
