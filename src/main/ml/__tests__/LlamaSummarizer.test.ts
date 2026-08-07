import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildLlamaArgs,
  parseLlamaOutput,
  extractFirstJSONObject,
  validateModelPath
} from '../LlamaSummarizer'
import { SUMMARIZATION_JSON_SCHEMA } from '../summarization-schema'

describe('buildLlamaArgs', () => {
  it('passes the JSON schema as --json-schema and uses single-turn mode', () => {
    const args = buildLlamaArgs({
      modelPath: '/models/gemma.gguf',
      promptFilePath: '/tmp/prompt.txt',
      maxTokens: 200
    })
    expect(args).toContain('-m')
    expect(args).toContain('/models/gemma.gguf')
    expect(args).toContain('-f')
    expect(args).toContain('/tmp/prompt.txt')
    // The grammar engine sees this schema and constrains token sampling so
    // the model can only emit valid {title, summary} JSON objects.
    expect(args).toContain('--json-schema')
    expect(args).toContain(SUMMARIZATION_JSON_SCHEMA)
    expect(args).toContain('-st')
    expect(args).toContain('-n')
    expect(args).toContain('200')
    expect(args).toContain('--no-display-prompt')
  })

  it('sets an explicit context size matching MAX_INPUT_CHARS', () => {
    // Ohne -c nutzt llama-cli seinen 4096-Default: von den früheren 120k
    // Prompt-Zeichen wurde der Großteil still truncated/context-geshiftet —
    // bezahlte Prompt-Eval-Zeit ohne Wirkung auf die Summary.
    const args = buildLlamaArgs({
      modelPath: '/models/gemma.gguf',
      promptFilePath: '/tmp/prompt.txt',
      maxTokens: 200
    })
    const cIdx = args.indexOf('-c')
    expect(cIdx).toBeGreaterThanOrEqual(0)
    expect(args[cIdx + 1]).toBe('8192')
  })
})

describe('extractFirstJSONObject', () => {
  it('finds a balanced top-level object in clean input', () => {
    expect(extractFirstJSONObject('{"a":1}')).toBe('{"a":1}')
  })

  it('finds the object surrounded by noise (banner + spinner + perf stats)', () => {
    const noisy = `Loading model... |-\\|/- \n[ banner ]\n|-\\|/ {"title":"X","summary":"Y"} \n[ Prompt: 615 t/s ]`
    expect(extractFirstJSONObject(noisy)).toBe('{"title":"X","summary":"Y"}')
  })

  it('respects JSON string semantics — braces inside strings do not close the object', () => {
    const tricky = 'noise {"title":"a {nested} b","summary":"with } char"} more noise'
    expect(extractFirstJSONObject(tricky)).toBe('{"title":"a {nested} b","summary":"with } char"}')
  })

  it('handles escaped quotes inside strings', () => {
    const escaped = '{"title":"He said \\"hi\\"","summary":"Test \\" with } char"}'
    expect(extractFirstJSONObject('garbage ' + escaped + ' trailing')).toBe(escaped)
  })

  it('returns null when no balanced object is present', () => {
    expect(extractFirstJSONObject('just text')).toBe(null)
    expect(extractFirstJSONObject('{ unbalanced')).toBe(null)
  })

  it('skips a stray closing brace and finds the real object after', () => {
    expect(extractFirstJSONObject('}}garbage}{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseLlamaOutput', () => {
  it('parses valid {title, summary} JSON wrapped in stdout noise', () => {
    const raw = `Loading model... |-\\|/- \n|-\\|/ {"title":"Schlafstörungen","summary":"Der Patient berichtet von Einschlafproblemen seit drei Wochen. Vereinbart wird ein Schlaftagebuch."}\n[ Prompt: 615 t/s | Generation: 83 t/s ]\nExiting...`
    expect(parseLlamaOutput(raw)).toEqual({
      title: 'Schlafstörungen',
      text: 'Der Patient berichtet von Einschlafproblemen seit drei Wochen. Vereinbart wird ein Schlaftagebuch.'
    })
  })

  it('parses real captured llama-cli stdout from a hardware run (regression fixture)', () => {
    const fixture = readFileSync(
      join(__dirname, '__fixtures__', 'llama-cli-real-stdout.txt'),
      'utf-8'
    )
    const result = parseLlamaOutput(fixture)
    expect(result.title).toBe('Elektronische Verfügungszustellung')
    expect(result.text).toMatch(/Postversand/)
    expect(result.text.length).toBeGreaterThan(50)
  })

  it('throws a readable error when stdout has no JSON object', () => {
    expect(() => parseLlamaOutput('just some text without json')).toThrow(
      /enthält kein JSON-Objekt/
    )
  })

  it('throws when the JSON is structurally invalid', () => {
    expect(() => parseLlamaOutput('garbage {"title":}')).toThrow(/JSON/)
  })

  it('throws when the JSON does not match the schema (missing fields)', () => {
    expect(() => parseLlamaOutput('{"title":"Only Title"}')).toThrow(/passt nicht zum Schema/)
  })

  it('throws when title is too short (defense-in-depth — grammar should prevent this)', () => {
    expect(() => parseLlamaOutput('{"title":"AB","summary":"' + 'a'.repeat(50) + '"}')).toThrow(
      /passt nicht zum Schema/
    )
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
