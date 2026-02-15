import type { TranscriptWord } from '../../shared/types'

// whisper.cpp token interface (subset needed for processing)
interface WhisperToken {
  text: string
  timestamps?: { from: string; to: string }
  offsets?: { from: number; to: number }
  id: number
  p: number
}

// Matches whisper internal control tokens: [_BEG_], [_TT_500], [_EOT_], [_SOT_], [_NOSPEECH_]
const SPECIAL_TOKEN_REGEX = /^\[_.*\]$/

export function isSpecialToken(text: string): boolean {
  return SPECIAL_TOKEN_REGEX.test(text.trim())
}

export function filterSpecialTokens(tokens: WhisperToken[]): WhisperToken[] {
  return tokens.filter((t) => !isSpecialToken(t.text))
}

// Merge BPE sub-tokens into whole words using whisper's leading-space convention:
// - Tokens starting with a space begin a new word (" Guten", " Tag")
// - Tokens without a leading space continue the previous word ("ib", "haus")
export function mergeSubTokens(tokens: WhisperToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = []

  for (const token of tokens) {
    const raw = token.text
    if (!raw || !raw.trim()) continue

    const startsNewWord = raw.startsWith(' ') || words.length === 0

    const start = token.offsets ? token.offsets.from / 1000 : 0
    const end = token.offsets ? token.offsets.to / 1000 : 0

    if (startsNewWord) {
      words.push({
        text: raw.trimStart(),
        start,
        end
      })
    } else {
      // Append to previous word
      const prev = words[words.length - 1]
      prev.text += raw
      prev.end = end
    }
  }

  return words
}

export type { WhisperToken }
