import { describe, it, expect } from 'vitest'
import { buildSummarizationPrompt } from '../summarization-prompt'

describe('buildSummarizationPrompt', () => {
  it('requests structured TITEL + ZUSAMMENFASSUNG output in German', () => {
    const prompt = buildSummarizationPrompt('Der Patient berichtet von Schlafstörungen.')
    expect(prompt).toContain('TITEL:')
    expect(prompt).toContain('ZUSAMMENFASSUNG:')
    expect(prompt).toContain('zwei')
    expect(prompt).toContain('Schlafstörungen')
  })

  it('truncates input exceeding 120k characters to fit model context', () => {
    const long = 'a'.repeat(200_000)
    const prompt = buildSummarizationPrompt(long)
    expect(prompt.length).toBeLessThan(150_000)
  })

  it('preserves placeholder chips inside the anonymized text verbatim', () => {
    const prompt = buildSummarizationPrompt('Der Patient [PERSON 1] war müde.')
    expect(prompt).toContain('[PERSON 1]')
  })
})
