import { describe, it, expect } from 'vitest'
import { buildManifest, type CatalogModel, type ManifestModel } from '../update-manifest'
import { ManifestSchema } from '../validation/model-update-schemas'

const sha = (c: string): string => c.repeat(64)
const now = new Date('2026-10-12T10:00:00.123Z')
const catalog: CatalogModel[] = [
  { id: 'asr', label: 'ASR', url: 'https://cdn/asr.bin', sha256: sha('a'), sizeBytes: 10 },
  { id: 'ner', label: 'NER', url: 'https://cdn/ner.tgz', sha256: sha('b'), sizeBytes: 20 }
]
const dmg = { url: 'https://gh/v1.2.0/Therascript.dmg', sha256: sha('d'), sizeBytes: 300 }
const liveModel = (over: Partial<ManifestModel>): ManifestModel => ({
  id: 'asr',
  version: '2026-01-01',
  label: 'ASR',
  url: 'https://cdn/asr.bin',
  sha256: sha('a'),
  sizeBytes: 10,
  ...over
})

describe('buildManifest', () => {
  it('beschreibt die App mit Version, URL, Grösse und Prüfsumme des DMG', () => {
    const manifest = buildManifest({ catalog, live: {}, appVersion: '1.2.0', dmg, now })
    expect(manifest.app).toEqual({ version: '1.2.0', ...dmg })
    expect(manifest.latestAppVersion).toBe('1.2.0')
    expect(manifest.generatedAt).toBe('2026-10-12T10:00:00Z')
  })

  it('behält Datum und minAppVersion eines unveränderten Artefakts', () => {
    const live = { models: [liveModel({ minAppVersion: '1.0.0' })] }
    const [asr] = buildManifest({ catalog, live, appVersion: '1.2.0', dmg, now }).models
    expect(asr.version).toBe('2026-01-01')
    expect(asr.minAppVersion).toBe('1.0.0')
  })

  it('setzt für ein neues oder geändertes Artefakt die Version dieses Releases', () => {
    const live = { models: [liveModel({ sha256: sha('f'), minAppVersion: '1.0.0' })] }
    const [asr, ner] = buildManifest({ catalog, live, appVersion: '1.2.0', dmg, now }).models
    expect(asr).toMatchObject({ version: '2026-10-12', minAppVersion: '1.2.0' })
    expect(ner).toMatchObject({ version: '2026-10-12', minAppVersion: '1.2.0' })
  })

  it('setzt minAppVersion auch für unveränderte Artefakte aus alten Manifesten ohne Feld', () => {
    const live = { models: [liveModel({})] }
    const [asr] = buildManifest({ catalog, live, appVersion: '1.2.0', dmg, now }).models
    expect(asr.minAppVersion).toBe('1.2.0')
    expect(asr.version).toBe('2026-01-01')
  })

  it('übernimmt ohne DMG den Live-App-Eintrag derselben Version (Modell-Update zwischen Releases)', () => {
    const liveApp = { version: '1.2.0', ...dmg }
    const manifest = buildManifest({ catalog, live: { app: liveApp }, appVersion: '1.2.0', now })
    expect(manifest.app).toEqual(liveApp)
  })

  it('bricht ohne DMG ab, wenn das Live-Manifest eine andere Version beschreibt', () => {
    const liveApp = { version: '1.1.0', ...dmg }
    expect(() =>
      buildManifest({ catalog, live: { app: liveApp }, appVersion: '1.2.0', now })
    ).toThrow(/App-Eintrag fehlt/)
  })

  it('erzeugt ein Manifest, das die App einlesen kann', () => {
    const manifest = buildManifest({ catalog, live: {}, appVersion: '1.2.0', dmg, now })
    expect(ManifestSchema.safeParse(manifest).success).toBe(true)
  })
})
