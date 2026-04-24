import { describe, it, expect } from 'vitest'
import { ManifestSchema, ManifestModelSchema } from '../model-update-schemas'

const validModel = {
  id: 'whisper-large-v3-turbo',
  version: '2025-01-15',
  label: 'Spracherkennung',
  url: 'https://example.com/model.bin',
  sha256: 'a'.repeat(64),
  sizeBytes: 574041195
}

const validManifest = {
  generatedAt: '2025-01-15T00:00:00Z',
  models: [validModel]
}

describe('ManifestModelSchema', () => {
  it('parses a valid model', () => {
    expect(ManifestModelSchema.parse(validModel)).toEqual(validModel)
  })

  it('rejects empty id', () => {
    expect(() => ManifestModelSchema.parse({ ...validModel, id: '' })).toThrow()
  })

  it('rejects invalid url', () => {
    expect(() => ManifestModelSchema.parse({ ...validModel, url: 'not-a-url' })).toThrow()
  })

  it('rejects sha256 with wrong length', () => {
    expect(() => ManifestModelSchema.parse({ ...validModel, sha256: 'abc123' })).toThrow()
  })

  it('rejects sha256 with non-hex chars', () => {
    const invalidHash = 'g'.repeat(64)
    expect(() => ManifestModelSchema.parse({ ...validModel, sha256: invalidHash })).toThrow()
  })

  it('accepts sha256 with all valid hex chars', () => {
    const validHash = '0123456789abcdef'.repeat(4)
    expect(ManifestModelSchema.parse({ ...validModel, sha256: validHash }).sha256).toBe(validHash)
  })

  it('rejects zero sizeBytes', () => {
    expect(() => ManifestModelSchema.parse({ ...validModel, sizeBytes: 0 })).toThrow()
  })

  it('rejects negative sizeBytes', () => {
    expect(() => ManifestModelSchema.parse({ ...validModel, sizeBytes: -1 })).toThrow()
  })

  it('rejects missing fields', () => {
    expect(() => ManifestModelSchema.parse({ id: 'test' })).toThrow()
  })
})

describe('ManifestSchema', () => {
  it('parses a valid manifest', () => {
    const result = ManifestSchema.parse(validManifest)
    expect(result.generatedAt).toBe('2025-01-15T00:00:00Z')
    expect(result.models).toHaveLength(1)
    expect(result.models[0].id).toBe('whisper-large-v3-turbo')
  })

  it('parses manifest with multiple models', () => {
    const manifest = {
      ...validManifest,
      models: [
        validModel,
        { ...validModel, id: 'pyannote-speaker-diarization-3.1', sha256: 'b'.repeat(64) },
        { ...validModel, id: 'flair-ner-german-large', sha256: 'c'.repeat(64) }
      ]
    }
    expect(ManifestSchema.parse(manifest).models).toHaveLength(3)
  })

  it('rejects empty models array', () => {
    expect(() => ManifestSchema.parse({ ...validManifest, models: [] })).toThrow()
  })

  it('rejects missing generatedAt', () => {
    expect(() => ManifestSchema.parse({ models: [validModel] })).toThrow()
  })

  it('rejects invalid model in array', () => {
    const manifest = {
      ...validManifest,
      models: [{ ...validModel, sha256: 'invalid' }]
    }
    expect(() => ManifestSchema.parse(manifest)).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => ManifestSchema.parse('{"models":[]}' )).toThrow()
    expect(() => ManifestSchema.parse(null)).toThrow()
    expect(() => ManifestSchema.parse(42)).toThrow()
  })
})
