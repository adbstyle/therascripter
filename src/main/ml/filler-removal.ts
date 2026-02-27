import type { TranscriptWord, TranscriptSegment } from '../../shared/types'

// Filler patterns per spec section 2.3 (Entscheidung #33: only "äh"/"ähm", real filler words stay)
const FILLER_PATTERNS = [
  /^[AaÄä]h+m?$/, // äh, ähm, ah, ahm
  /^[Uu]h+m?$/, // uh, uhm
  /^[Hh]m+$/, // hm, hmm
  /^[Mm]h+m?$/ // mhm, mh
]

function isFillerWord(word: string): boolean {
  const trimmed = word.replace(/[.,!?;:]+$/, '')
  return FILLER_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function removeFillerWords(words: TranscriptWord[]): TranscriptWord[] {
  return words.filter((w) => !isFillerWord(w.text))
}

export function rebuildSegments(words: TranscriptWord[]): TranscriptSegment[] {
  if (words.length === 0) return []

  const segments: TranscriptSegment[] = []
  let currentWords: TranscriptWord[] = []

  for (const word of words) {
    currentWords.push(word)

    // Split on sentence-ending punctuation
    if (/[.!?]$/.test(word.text)) {
      segments.push({
        text: currentWords.map((w) => w.text).join(' '),
        start: currentWords[0].start,
        end: word.end
      })
      currentWords = []
    }
  }

  // Remaining words form a final segment
  if (currentWords.length > 0) {
    segments.push({
      text: currentWords.map((w) => w.text).join(' '),
      start: currentWords[0].start,
      end: currentWords[currentWords.length - 1].end
    })
  }

  return segments
}
