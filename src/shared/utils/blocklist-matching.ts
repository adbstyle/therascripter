/**
 * Shared blocklist matching utilities.
 * Used by both main process (entity-merger) and renderer (retroactive scan).
 */

/**
 * Bidirectional Umlaut normalization for matching.
 * Both sides (text + search term) are normalized to the same form.
 * ue, ae, oe, ss
 */
export function normalizeUmlaut(text: string): string {
  return text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
}

/**
 * Check if a match at [start, end) falls on word boundaries.
 * Prevents "Müller" from matching inside "Müllerstrasse".
 */
export function isWholeWord(text: string, start: number, end: number): boolean {
  const wordBoundary = /[\s.,;:!?()[\]{}"'/\-—–\n\r\t]/
  const before = start === 0 || wordBoundary.test(text[start - 1])
  const after = end >= text.length || wordBoundary.test(text[end])
  return before && after
}

export interface NormalizedWithMap {
  normalized: string
  toOriginal: number[] // normalizedPos -> originalPos (includes sentinel at end)
}

/**
 * Normalize text for umlaut matching while building a position map
 * from normalized positions back to original positions.
 * This handles the length change when ue, ae, oe, ss.
 */
export function normalizeWithPositionMap(text: string): NormalizedWithMap {
  const parts: string[] = []
  const toOriginal: number[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    let replacement: string
    switch (ch) {
      case 'ä':
        replacement = 'ae'
        break
      case 'ö':
        replacement = 'oe'
        break
      case 'ü':
        replacement = 'ue'
        break
      case 'ß':
        replacement = 'ss'
        break
      default:
        replacement = ch
        break
    }
    for (let j = 0; j < replacement.length; j++) {
      toOriginal.push(i)
    }
    parts.push(replacement)
  }
  // Sentinel: position after last char maps to original text length
  toOriginal.push(text.length)

  return { normalized: parts.join(''), toOriginal }
}
