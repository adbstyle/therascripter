import { describe, it, expect } from 'vitest'
import { buildLlamaArgs, parseLlamaOutput, validateModelPath } from '../LlamaSummarizer'

describe('buildLlamaArgs', () => {
  it('includes required flags with given model + prompt path', () => {
    const args = buildLlamaArgs({
      modelPath: '/models/gemma.gguf',
      promptFilePath: '/tmp/prompt.txt',
      maxTokens: 200
    })
    expect(args).toContain('-m')
    expect(args).toContain('/models/gemma.gguf')
    expect(args).toContain('-f')
    expect(args).toContain('/tmp/prompt.txt')
    // Single-turn mode: applies the model's jinja chat template + exits
    // after one response. Without this, llama-cli b8920+ either skips the
    // chat template (raw -p mode → garbage) or hangs in interactive mode.
    expect(args).toContain('-st')
    expect(args).toContain('-n')
    expect(args).toContain('200')
    expect(args).toContain('--no-display-prompt')
  })
})

describe('parseLlamaOutput', () => {
  it('extracts TITEL and ZUSAMMENFASSUNG fields into a structured result', () => {
    const raw =
      'TITEL: Schlafstörungen und Arbeitsstress\nZUSAMMENFASSUNG: Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.\n[end of text]'
    expect(parseLlamaOutput(raw)).toEqual({
      title: 'Schlafstörungen und Arbeitsstress',
      text: 'Der Patient berichtet von Einschlafproblemen. Vereinbart wird ein Schlaftagebuch.'
    })
  })

  it('strips any trailing [end of text] marker and trims whitespace', () => {
    const raw = 'TITEL: Thema\nZUSAMMENFASSUNG: Satz eins. Satz zwei.\n\nllama_print_timings: ...'
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('tolerates lowercase variants and leading/trailing whitespace around keys', () => {
    const raw = '  titel: Thema  \n  zusammenfassung:  Satz eins. Satz zwei.  '
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('captures the full summary when the LLM splits it across multiple lines', () => {
    const raw = 'TITEL: Thema\nZUSAMMENFASSUNG: Satz eins.\nSatz zwei.'
    expect(parseLlamaOutput(raw)).toEqual({ title: 'Thema', text: 'Satz eins. Satz zwei.' })
  })

  it('throws a readable error when the output is missing either field', () => {
    expect(() => parseLlamaOutput('something else entirely')).toThrow(/TITEL|ZUSAMMENFASSUNG/)
  })
})

describe('validateModelPath', () => {
  it('accepts paths under the allowed models directory', () => {
    expect(() =>
      validateModelPath('/root/models/summarization/gemma.gguf', '/root/models')
    ).not.toThrow()
  })

  it('rejects paths that escape the allowed directory', () => {
    expect(() => validateModelPath('/root/models/../etc/passwd', '/root/models')).toThrow()
    expect(() => validateModelPath('/etc/passwd', '/root/models')).toThrow()
  })
})
