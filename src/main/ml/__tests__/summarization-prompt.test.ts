import { describe, it, expect } from 'vitest'
import { buildSummarizationPrompt } from '../summarization-prompt'

describe('buildSummarizationPrompt', () => {
  it('asks for a JSON object with title + summary fields in German', () => {
    const prompt = buildSummarizationPrompt('Der Patient berichtet von Schlafstörungen.')
    expect(prompt).toContain('JSON-Objekt')
    expect(prompt).toContain('title')
    expect(prompt).toContain('summary')
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

  it('does NOT diktat the line-by-line format (the JSON schema enforces structure)', () => {
    const prompt = buildSummarizationPrompt('test')
    // The old prompt forced "TITEL:" / "ZUSAMMENFASSUNG:" headers via text
    // instructions; we now rely on llama-cli's --json-schema grammar engine
    // to enforce structure at the token-sampling level. Belt-and-suspenders
    // guard so a future edit doesn't accidentally re-introduce the old
    // free-text-format approach without also dropping the schema constraint.
    expect(prompt).not.toContain('TITEL:')
    expect(prompt).not.toContain('ZUSAMMENFASSUNG:')
  })
})
