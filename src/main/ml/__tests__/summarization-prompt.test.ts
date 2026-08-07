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

  it('truncates input to what actually fits the -c 8192 context window', () => {
    // 120k Zeichen (~30-40k Tokens) gegen ein 8192er-Kontextfenster hieß:
    // der Großteil der Prompt-Eval-Zeit war bezahlt, aber wirkungslos.
    // 24k Zeichen ≈ 6k Tokens + Instruction + 400 Output-Tokens < 8192.
    const long = 'a'.repeat(200_000)
    const prompt = buildSummarizationPrompt(long)
    expect(prompt.length).toBeLessThan(26_000)
    expect(prompt).toContain('[... gekürzt ...]')
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
