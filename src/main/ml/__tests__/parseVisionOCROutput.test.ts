import { describe, it, expect } from 'vitest'
import { parseVisionOCROutput } from '../VisionOCRService'

describe('parseVisionOCROutput', () => {
  it('extracts and dehyphenates the text field from valid JSON output', () => {
    const stdout = JSON.stringify({
      text: 'Der Patient wohnt im Al-\ntersheim.',
      confidence: 0.97,
      language: 'de',
      pageNumber: 3
    })
    expect(parseVisionOCROutput(stdout, 3)).toBe('Der Patient wohnt im Altersheim.')
  })

  it('throws on unparsable stdout instead of accepting it as OCR text', () => {
    // Vorher wurde z. B. ein Warning-Banner des Binaries stillschweigend als
    // Seitentext ins Transkript übernommen — Silent Data Corruption.
    expect(() => parseVisionOCROutput('WARNING: something went sideways', 3)).toThrow(/Seite 3/)
  })

  it('throws on valid JSON that is missing the text field', () => {
    expect(() => parseVisionOCROutput('{"confidence": 0.5}', 7)).toThrow(/Seite 7/)
  })

  it('accepts an empty text field (blank scanned page)', () => {
    const stdout = JSON.stringify({ text: '', confidence: 0, language: 'de', pageNumber: 1 })
    expect(parseVisionOCROutput(stdout, 1)).toBe('')
  })
})
