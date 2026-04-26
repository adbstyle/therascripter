import { describe, it, expect } from 'vitest'
import { ModelGroupSchema } from '../model-catalog-schemas'

describe('ModelGroupSchema', () => {
  it('accepts "summarization" as a valid group', () => {
    expect(ModelGroupSchema.parse('summarization')).toBe('summarization')
  })

  it('still accepts the existing groups', () => {
    expect(ModelGroupSchema.parse('asr')).toBe('asr')
    expect(ModelGroupSchema.parse('diarization')).toBe('diarization')
    expect(ModelGroupSchema.parse('ner')).toBe('ner')
  })

  it('rejects unknown groups', () => {
    expect(() => ModelGroupSchema.parse('unknown')).toThrow()
  })
})
