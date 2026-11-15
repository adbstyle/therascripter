import { describe, it, expect } from 'vitest'
import { buildManifest, type CatalogModel, type ManifestModel } from '../update-manifest'
import { parseManifest } from '../validation/model-update-schemas'
import { MODEL_DEFINITIONS, isPublished } from '../model-catalog'

const sha = (c: string): string => c.repeat(64)
const now = new Date('2026-10-12T10:00:00.123Z')
const catalog: CatalogModel[] = [
  {
    id: 'asr',
    label: 'ASR',
    url: 'https://cdn/asr.bin',
    sha256: sha('a'),
    sizeBytes: 10,
    relativePath: 'asr/asr.bin',
    checkPath: 'asr/asr.bin',
    group: 'asr'
  },
  {
    id: 'ner',
    label: 'NER',
    url: 'https://cdn/ner.tgz',
    sha256: sha('b'),
    sizeBytes: 20,
    relativePath: 'ner',
    checkPath: 'ner/model',
    archive: true,
    group: 'ner',
    isRequired: true
  }
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
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)))
    expect(parsed.models).toHaveLength(2)
    expect(parsed.app).toEqual(manifest.app)
  })

  it('nennt für jedes Modell die Ablage aus dem Katalog (#167)', () => {
    const live = { models: [liveModel({ minAppVersion: '1.0.0' })] }
    const [asr, ner] = buildManifest({ catalog, live, appVersion: '1.2.0', dmg, now }).models
    expect(asr).toMatchObject({
      relativePath: 'asr/asr.bin',
      checkPath: 'asr/asr.bin',
      archive: false,
      group: 'asr',
      required: false
    })
    expect(ner).toMatchObject({
      relativePath: 'ner',
      checkPath: 'ner/model',
      archive: true,
      required: true
    })
  })

  it('jedes Modell des echten Katalogs übersteht die Prüfung der App (#167)', () => {
    const manifest = buildManifest({
      catalog: MODEL_DEFINITIONS,
      live: {},
      appVersion: '1.2.0',
      dmg,
      now
    })
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)))
    expect(parsed.models.map((m) => m.id)).toEqual(
      MODEL_DEFINITIONS.filter(isPublished).map((m) => m.id)
    )
  })

  describe('Schalter «noch nicht veröffentlicht» (Suchmodell, Epic #192)', () => {
    const search = MODEL_DEFINITIONS.find((m) => m.id === 'embeddinggemma-2-text')!

    it('der echte Katalog führt das Suchmodell mit echtem Hash, veröffentlicht (R2 seit 2026-11-15)', () => {
      expect(search.sha256).toBe('49e225895475004c699f08390f822e92a1fa8be4882e03e50d44c50f3badf4f8')
      expect(search.sizeBytes).toBe(430_211_881)
      expect(search.published).toBeUndefined()
      expect(isPublished(search)).toBe(true)
    })

    it('published: false — kein Manifest-Eintrag, kein Abbruch', () => {
      const manifest = buildManifest({
        catalog: [...catalog, { ...search, published: false }],
        live: {},
        appVersion: '1.2.0',
        dmg,
        now
      })
      expect(manifest.models.map((m) => m.id)).toEqual(['asr', 'ner'])
    })

    it('veröffentlicht — Pflichtmodell mit Ablage, damit eine ältere App es mitlädt', () => {
      const manifest = buildManifest({
        catalog: [...catalog, { ...search, published: true }],
        live: {},
        appVersion: '1.2.0',
        dmg,
        now
      })
      const entry = manifest.models.find((m) => m.id === search.id)
      expect(entry).toMatchObject({
        relativePath: 'search-embeddinggemma-2-text-v1',
        checkPath: 'search-embeddinggemma-2-text-v1/READY',
        archive: true,
        group: 'search',
        required: true,
        minAppVersion: '1.2.0',
        sha256: search.sha256,
        sizeBytes: search.sizeBytes
      })
      expect(() => parseManifest(JSON.parse(JSON.stringify(manifest)))).not.toThrow()
    })

    it('der alte Platzhalter-Hash wirkt wie published: false', () => {
      expect(isPublished({ sha256: '0'.repeat(64) })).toBe(false)
      expect(isPublished({ sha256: 'a'.repeat(64) })).toBe(true)
      expect(isPublished({ sha256: 'a'.repeat(64), published: true })).toBe(true)
    })
  })
})
