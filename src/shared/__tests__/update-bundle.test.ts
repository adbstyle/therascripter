import { describe, it, expect } from 'vitest'
import {
  bundleBytes,
  bundleKey,
  modelStagingBytes,
  selectBundle,
  type LocalLayout,
  type SelectContext
} from '../update-bundle'
import type { ManifestModelInput } from '../validation/model-update-schemas'

const sha = (c: string): string => c.repeat(64)
const app = {
  version: '1.1.0',
  url: 'https://gh/Therascript.dmg',
  sha256: sha('d'),
  sizeBytes: 300
}

const LOCAL: LocalLayout[] = [
  { id: 'asr', relativePath: 'asr/a.bin', checkPath: 'asr/a.bin', archive: false, required: false },
  { id: 'ner', relativePath: 'ner', checkPath: 'ner/model', archive: true, required: true }
]

const entry = (over: Partial<ManifestModelInput> & { id: string }): ManifestModelInput => ({
  version: '2026-10-12',
  label: over.id,
  url: `https://cdn/${over.id}`,
  sha256: sha('n'),
  sizeBytes: 100,
  ...over
})

function ctx(over: Partial<SelectContext> = {}): SelectContext {
  return {
    currentVersion: '1.0.0',
    appInstallable: true,
    localLayouts: LOCAL,
    retiredIds: new Set(),
    installedSha: () => sha('o'),
    isOnDisk: (checkPath) => checkPath === 'asr/a.bin' || checkPath === 'ner/model',
    ...over
  }
}

const ids = (b: ReturnType<typeof selectBundle>): string[] => b?.models.map((m) => m.id) ?? []

describe('selectBundle (#167)', () => {
  it('bündelt eine neue App mit den Updates der installierten Modelle', () => {
    const bundle = selectBundle(
      { app, models: [entry({ id: 'asr' }), entry({ id: 'ner' })] },
      ctx()
    )
    expect(bundle?.app).toEqual(app)
    expect(bundle?.models.map((m) => [m.id, m.kind])).toEqual([
      ['asr', 'update'],
      ['ner', 'update']
    ])
    expect(bundle?.models[1]).toMatchObject({ relativePath: 'ner', archive: true, required: true })
  })

  it('bietet ein reines Modell-Update an, wenn es keine neuere App gibt (AK 2)', () => {
    const bundle = selectBundle(
      { app: { ...app, version: '1.0.0' }, models: [entry({ id: 'asr' })] },
      ctx()
    )
    expect(bundle?.app).toBeNull()
    expect(ids(bundle)).toEqual(['asr'])
  })

  it('bietet nichts an, wenn alles aktuell ist', () => {
    expect(selectBundle({ models: [entry({ id: 'asr', sha256: sha('o') })] }, ctx())).toBeNull()
  })

  it('behandelt den Altbestand ohne bekannte Prüfsumme als veraltet', () => {
    const bundle = selectBundle({ models: [entry({ id: 'asr' })] }, ctx({ installedSha: () => '' }))
    expect(ids(bundle)).toEqual(['asr'])
  })

  it('bietet nicht installierte Wahlmodelle nie an', () => {
    const bundle = selectBundle(
      { app, models: [entry({ id: 'asr' })] },
      ctx({ isOnDisk: () => false })
    )
    expect(ids(bundle)).toEqual([])
  })

  describe('minAppVersion (AK 6)', () => {
    it('ohne neue App nur Modelle, die zur installierten Version passen', () => {
      const models = [
        entry({ id: 'asr', minAppVersion: '1.0.0' }),
        entry({ id: 'ner', minAppVersion: '1.1.0' })
      ]
      expect(ids(selectBundle({ models }, ctx()))).toEqual(['asr'])
    })

    it('mit neuer App auch Modelle bis zu deren Version', () => {
      const models = [
        entry({ id: 'asr', minAppVersion: '1.1.0' }),
        entry({ id: 'ner', minAppVersion: '1.2.0' })
      ]
      expect(ids(selectBundle({ app, models }, ctx()))).toEqual(['asr'])
    })

    it('kann sich die App nicht selbst ersetzen, bleiben Modelle der neuen Version weg', () => {
      const models = [entry({ id: 'asr', minAppVersion: '1.1.0' }), entry({ id: 'ner' })]
      const bundle = selectBundle({ app, models }, ctx({ appInstallable: false }))
      expect(bundle?.app).toBeNull()
      expect(ids(bundle)).toEqual(['ner'])
    })
  })

  describe('Pflichtmodelle der neuen Version (AK 4)', () => {
    const vad = entry({
      id: 'vad',
      relativePath: 'vad',
      checkPath: 'vad/model.onnx',
      archive: true,
      required: true,
      minAppVersion: '1.1.0'
    })

    it('kommen mit der neuen App im selben Vorgang, auch wenn der eigene Katalog sie nicht kennt', () => {
      const bundle = selectBundle({ app, models: [vad] }, ctx())
      expect(bundle?.models).toEqual([
        expect.objectContaining({ id: 'vad', kind: 'new', relativePath: 'vad', archive: true })
      ])
    })

    it('kommen nie ohne neue App (fehlende Pflichtmodelle sind Sache der Ersteinrichtung)', () => {
      const bundle = selectBundle({ models: [{ ...vad, minAppVersion: undefined }] }, ctx())
      expect(bundle).toBeNull()
    })

    it('ein nicht installiertes Wahlmodell der neuen Version kommt nicht mit', () => {
      const bundle = selectBundle({ app, models: [{ ...vad, required: false }] }, ctx())
      expect(ids(bundle)).toEqual([])
    })
  })

  describe('Ablage', () => {
    it('nimmt ohne Angaben in der Beschreibung die Ablage des eigenen Katalogs', () => {
      const bundle = selectBundle({ models: [entry({ id: 'ner' })] }, ctx())
      expect(bundle?.models[0]).toMatchObject({ relativePath: 'ner', checkPath: 'ner/model' })
    })

    it('überspringt unbekannte Modelle ohne Ablage', () => {
      expect(selectBundle({ app, models: [entry({ id: 'neu' })] }, ctx())?.models).toEqual([])
    })

    it('ohne neue App muss die Ablage zu diesem Katalog passen', () => {
      const moved = entry({
        id: 'ner',
        relativePath: 'ner2',
        checkPath: 'ner2/model',
        archive: true
      })
      expect(selectBundle({ models: [moved] }, ctx())).toBeNull()
    })

    it('ersetzt nie einen Ordner, in dem ein anderes Modell liegt', () => {
      const clash = entry({
        id: 'asr2',
        relativePath: 'ner',
        checkPath: 'ner/x',
        archive: true,
        required: true
      })
      const parent = entry({
        id: 'all',
        relativePath: 'asr',
        checkPath: 'asr',
        archive: true,
        required: true
      })
      expect(ids(selectBundle({ app, models: [clash, parent] }, ctx()))).toEqual([])
    })

    it('überspringt ausgemusterte Modelle', () => {
      const bundle = selectBundle(
        { models: [entry({ id: 'asr' })] },
        ctx({ retiredIds: new Set(['asr']) })
      )
      expect(bundle).toBeNull()
    })
  })

  it('Schlüssel und Grösse fassen alle Teile', () => {
    const a = selectBundle({ app, models: [entry({ id: 'asr' }), entry({ id: 'ner' })] }, ctx())!
    const b = selectBundle({ app, models: [entry({ id: 'ner' }), entry({ id: 'asr' })] }, ctx())!
    expect(bundleKey(a)).toBe(bundleKey(b))
    expect(bundleKey(a)).not.toBe(bundleKey({ ...a, models: a.models.slice(1) }))
    expect(bundleBytes(a)).toBe(500)
    expect(modelStagingBytes({ sizeBytes: 100, archive: true })).toBe(250)
    expect(modelStagingBytes({ sizeBytes: 100, archive: false })).toBe(100)
  })
})
