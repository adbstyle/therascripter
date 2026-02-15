import type { TranscriptSegment } from '../../shared/types'
import type { RegexEntity } from '../../shared/types/NerTypes'

interface PatternDef {
  pattern: RegExp
  regexType: string
}

// Swiss phone: +41 79 123 45 67, 079 123 45 67, 044 123 45 67
const SWISS_PHONE: PatternDef = {
  pattern: /(?:\+41|0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}/g,
  regexType: 'TELEFON'
}

// International phone with country code: +49 30 12345678
const INTL_PHONE: PatternDef = {
  pattern: /\+\d{1,3}\s?\d{2,4}\s?\d{3,8}(?:\s?\d{2,4})?/g,
  regexType: 'TELEFON'
}

// AHV number: 756.1234.5678.97
const AHV_NUMMER: PatternDef = {
  pattern: /756\.\d{4}\.\d{4}\.\d{2}/g,
  regexType: 'AHV'
}

// Email
const EMAIL: PatternDef = {
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  regexType: 'EMAIL'
}

// Swiss PLZ + Ort: 8001 Zürich, 3011 Bern, 6003 Luzern
const PLZ_ORT: PatternDef = {
  pattern: /\b\d{4}\s+[A-ZÄÖÜ][a-zäöüéèêàá]+(?:[\s-][A-ZÄÖÜ][a-zäöüéèêàá]+)*\b/g,
  regexType: 'PLZ_ORT'
}

// Geburtsdatum with context: "geb. 15.03.1985", "geboren am 15.3.85"
const GEBURTSDATUM: PatternDef = {
  pattern: /\b(?:geb\.?|geboren)\s*(?:am\s*)?\d{1,2}\.\d{1,2}\.\d{2,4}\b/gi,
  regexType: 'GEBURTSDATUM'
}

// Standalone date that looks like a birth date (DD.MM.YYYY with 4-digit year)
const DATE_FULL: PatternDef = {
  pattern: /\b\d{1,2}\.\d{1,2}\.\d{4}\b/g,
  regexType: 'DATUM_STANDALONE'
}

// Swiss insurance/case number: various formats like 80756.01.00012345.67
const VERSICHERUNG: PatternDef = {
  pattern: /\b\d{5}\.\d{2}\.\d{8}\.\d{2}\b/g,
  regexType: 'VERSICHERUNG'
}

// Case number patterns: Fall-Nr. 2024-A7, Dossier 12345
const FALL_NR: PatternDef = {
  pattern: /\b(?:Fall-?Nr\.?|Dossier|Aktenzeichen)\s*:?\s*[\w-]+/gi,
  regexType: 'FALL_NR'
}

// Swiss street address: Bahnhofstrasse 42, Musterweg 7a
const STRASSE: PatternDef = {
  pattern: /\b[A-ZÄÖÜ][a-zäöüéèê]+(?:strasse|str\.|weg|gasse|platz|allee)\s+\d+[a-z]?\b/gi,
  regexType: 'STRASSE'
}

const ALL_PATTERNS: PatternDef[] = [
  AHV_NUMMER,
  SWISS_PHONE,
  INTL_PHONE,
  EMAIL,
  PLZ_ORT,
  GEBURTSDATUM,
  VERSICHERUNG,
  FALL_NR,
  STRASSE,
  DATE_FULL
]

/**
 * Map regex types to Therascript placeholder types.
 */
export function mapRegexTypeToPlaceholder(
  regexType: string
): 'KONTAKT' | 'ORT' | 'DATUM' {
  switch (regexType) {
    case 'TELEFON':
    case 'EMAIL':
    case 'AHV':
    case 'VERSICHERUNG':
    case 'FALL_NR':
    case 'STRASSE':
      return 'KONTAKT'
    case 'PLZ_ORT':
      return 'ORT'
    case 'GEBURTSDATUM':
    case 'DATUM_STANDALONE':
      return 'DATUM'
    default:
      return 'KONTAKT'
  }
}

/**
 * Run all regex patterns on transcript segments.
 * Returns entities with segment index and char spans.
 */
export function runRegexEngine(segments: TranscriptSegment[]): RegexEntity[] {
  const results: RegexEntity[] = []

  for (let i = 0; i < segments.length; i++) {
    const text = segments[i].text

    for (const { pattern, regexType } of ALL_PATTERNS) {
      // Reset regex lastIndex for each segment
      const re = new RegExp(pattern.source, pattern.flags)
      let match: RegExpExecArray | null

      while ((match = re.exec(text)) !== null) {
        results.push({
          text: match[0],
          regexType,
          segmentIndex: i,
          charStart: match.index,
          charEnd: match.index + match[0].length
        })
      }
    }
  }

  // Sort by segment index, then position
  results.sort((a, b) => {
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex
    return a.charStart - b.charStart
  })

  // Remove overlapping matches (keep the longer/earlier one)
  return deduplicateRegex(results)
}

function deduplicateRegex(entities: RegexEntity[]): RegexEntity[] {
  const result: RegexEntity[] = []

  for (const entity of entities) {
    const overlaps = result.some(
      (existing) =>
        existing.segmentIndex === entity.segmentIndex &&
        existing.charStart < entity.charEnd &&
        existing.charEnd > entity.charStart
    )
    if (!overlaps) {
      result.push(entity)
    }
  }

  return result
}
