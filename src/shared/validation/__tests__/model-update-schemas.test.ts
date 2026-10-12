import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ManifestModelSchema, parseManifest } from '../model-update-schemas'

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

describe('ManifestModelSchema — Ablage und Herkunft (#167)', () => {
  const layout = { relativePath: 'ner', checkPath: 'ner/hf/model', archive: true, required: true }

  it('akzeptiert die Ablage des echten Katalogs', () => {
    expect(ManifestModelSchema.safeParse({ ...validModel, ...layout }).success).toBe(true)
    expect(
      ManifestModelSchema.safeParse({
        ...validModel,
        relativePath: 'asr/ggml.bin',
        checkPath: 'asr/ggml.bin'
      }).success
    ).toBe(true)
  })

  it.each([
    ['../x', '../x'],
    ['/abs', '/abs'],
    ['a//b', 'a//b'],
    ['.update', '.update'],
    ['a/../b', 'a/../b'],
    ['a\\b', 'a\\b'],
    ['a\u0000b', 'a\u0000b']
  ])('weist den Pfad %s ab', (relativePath, checkPath) => {
    expect(ManifestModelSchema.safeParse({ ...validModel, relativePath, checkPath }).success).toBe(
      false
    )
  })

  it('verlangt einen Prüfpfad innerhalb des Ordners', () => {
    expect(
      ManifestModelSchema.safeParse({ ...validModel, ...layout, checkPath: 'diarization/x' })
        .success
    ).toBe(false)
    expect(ManifestModelSchema.safeParse({ ...validModel, relativePath: 'ner' }).success).toBe(
      false
    )
  })

  it('erlaubt Archive nur in einem eigenen Ordner direkt unter models/', () => {
    expect(
      ManifestModelSchema.safeParse({
        ...validModel,
        relativePath: 'asr/sub',
        checkPath: 'asr/sub',
        archive: true
      }).success
    ).toBe(false)
  })

  it('lädt nur verschlüsselt', () => {
    expect(
      ManifestModelSchema.safeParse({ ...validModel, url: 'http://example.com/m.bin' }).success
    ).toBe(false)
  })

  it('weist Modell-IDs mit Pfadzeichen ab', () => {
    expect(ManifestModelSchema.safeParse({ ...validModel, id: 'a/b' }).success).toBe(false)
    expect(ManifestModelSchema.safeParse({ ...validModel, id: '..' }).success).toBe(false)
  })

  it('nimmt eine unbekannte Modellgruppe hin', () => {
    expect(ManifestModelSchema.safeParse({ ...validModel, group: 'embedding' }).success).toBe(true)
  })
})

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const result = parseManifest(validManifest)
    expect(result.generatedAt).toBe('2025-01-15T00:00:00Z')
    expect(result.models).toHaveLength(1)
    expect(result.models[0].id).toBe('whisper-large-v3-turbo')
  })

  it('parses manifest with multiple models', () => {
    const manifest = {
      ...validManifest,
      models: [
        validModel,
        { ...validModel, id: 'pyannote-suite', sha256: 'b'.repeat(64) },
        { ...validModel, id: 'flair-ner-german-large', sha256: 'c'.repeat(64) }
      ]
    }
    expect(parseManifest(manifest).models).toHaveLength(3)
  })

  it('rejects empty models array', () => {
    expect(() => parseManifest({ ...validManifest, models: [] })).toThrow()
  })

  it('rejects missing generatedAt', () => {
    expect(() => parseManifest({ models: [validModel] })).toThrow()
  })

  it('verwirft nur den fehlerhaften Modell-Eintrag, nicht die ganze Beschreibung', () => {
    const log = vi.fn()
    const manifest = {
      ...validManifest,
      models: [
        { ...validModel, sha256: 'invalid' },
        { ...validModel, id: 'pyannote-suite' }
      ]
    }
    expect(parseManifest(manifest, log).models.map((m) => m.id)).toEqual(['pyannote-suite'])
    expect(log).toHaveBeenCalledOnce()
  })

  it('verwirft einen unbrauchbaren App-Eintrag, behält die Modelle', () => {
    const manifest = { ...validManifest, app: { version: '1.0', url: 'x' } }
    const parsed = parseManifest(manifest)
    expect(parsed.app).toBeUndefined()
    expect(parsed.models).toHaveLength(1)
  })

  it('rejects non-object input', () => {
    expect(() => parseManifest('{"models":[]}')).toThrow()
    expect(() => parseManifest(null)).toThrow()
    expect(() => parseManifest(42)).toThrow()
  })

  it('ältere Apps lesen die neue Beschreibung weiter — die Ablage-Felder fallen weg', () => {
    // Schema bis v0.9.x (vor #167), unverändert kopiert
    const OldModelSchema = z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      label: z.string().min(1),
      url: z.string().url(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().positive(),
      minAppVersion: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .optional()
    })
    const entry = {
      ...validModel,
      relativePath: 'ner',
      checkPath: 'ner/x',
      archive: true,
      group: 'ner',
      required: true
    }
    expect(OldModelSchema.parse(entry)).toEqual(validModel)
  })
})
