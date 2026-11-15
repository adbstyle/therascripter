import { describe, it, expect } from 'vitest'
import { MODEL_DEFINITIONS, SEARCH_MODEL_DIR_NAME, SEARCH_MODEL_READY_FILE } from '../model-catalog'
import { buildManifest } from '../update-manifest'
import { selectBundle, type LocalLayout, type SelectContext } from '../update-bundle'
import { parseManifest } from '../validation/model-update-schemas'
import { parseManifest as parseManifestV0101 } from './fixtures/v0.10.1/model-update-schemas'
import { selectBundle as selectBundleV0101 } from './fixtures/v0.10.1/update-bundle'

/**
 * Durchlauf Katalog → signiertes Manifest → parseManifest → selectBundle für
 * das veröffentlichte Suchmodell (Epic #192, Review PR #224): der Eintrag muss
 * die Prüfung JEDER App überstehen — dieser und der Vorversion v0.10.1
 * (Fixtures unter fixtures/v0.10.1, unverändert aus dem Tag).
 */
const SEARCH_ID = 'embeddinggemma-2-text'
const search = MODEL_DEFINITIONS.find((m) => m.id === SEARCH_ID)!
const dmg = { url: 'https://gh/v1.0.0/Therascript.dmg', sha256: 'd'.repeat(64), sizeBytes: 300 }

function publishedManifest(): unknown {
  const manifest = buildManifest({
    catalog: MODEL_DEFINITIONS.map((m) => (m.id === SEARCH_ID ? { ...m, published: true } : m)),
    live: {},
    appVersion: '1.0.0',
    dmg,
    now: new Date('2026-11-14T10:00:00Z')
  })
  // Wie über das Netz: nur JSON überlebt
  return JSON.parse(JSON.stringify(manifest))
}

/** Lokaler Katalog einer App, die das Suchmodell (noch) nicht kennt — z. B. v0.10.1. */
const LAYOUTS_WITHOUT_SEARCH: LocalLayout[] = MODEL_DEFINITIONS.filter(
  (m) => m.group !== 'search' && m.sha256 !== '0'.repeat(64)
).map((m) => ({
  id: m.id,
  relativePath: m.relativePath,
  checkPath: m.checkPath,
  archive: m.archive === true,
  required: m.isRequired === true
}))

function ctx(over: Partial<SelectContext> = {}): SelectContext {
  const onDisk = new Set(LAYOUTS_WITHOUT_SEARCH.map((l) => l.checkPath))
  return {
    currentVersion: '0.10.1',
    appInstallable: true,
    localLayouts: LAYOUTS_WITHOUT_SEARCH,
    retiredIds: new Set(),
    // Installierte Modelle haben die Fassung des Manifests — kein Update ausser dem Suchmodell
    installedSha: (id) => MODEL_DEFINITIONS.find((m) => m.id === id)?.sha256 ?? null,
    isOnDisk: (p) => onDisk.has(p),
    ...over
  }
}

describe('Suchmodell im Manifest (Review PR #224)', () => {
  it('liegt in einem eigenen Ordner direkt unter models/ (Archiv-Regel des Manifests)', () => {
    expect(search.relativePath).toBe(SEARCH_MODEL_DIR_NAME)
    expect(SEARCH_MODEL_DIR_NAME).not.toContain('/')
    expect(search.checkPath).toBe(`${SEARCH_MODEL_DIR_NAME}/${SEARCH_MODEL_READY_FILE}`)
  })

  it.each([
    ['diese Version', parseManifest],
    ['v0.10.1', parseManifestV0101]
  ])('übersteht parseManifest (%s) — kein verworfener Eintrag', (_name, parse) => {
    const logs: string[] = []
    const parsed = parse(publishedManifest(), (m) => logs.push(m))
    expect(logs).toEqual([])
    expect(parsed.models.map((m) => m.id)).toContain(SEARCH_ID)
    expect(parsed.models.find((m) => m.id === SEARCH_ID)).toMatchObject({
      relativePath: SEARCH_MODEL_DIR_NAME,
      checkPath: `${SEARCH_MODEL_DIR_NAME}/READY`,
      archive: true,
      group: 'search',
      required: true,
      minAppVersion: '1.0.0',
      sizeBytes: 430_211_881
    })
  })

  it('eine App ohne Suche (v0.10.1) bekommt es mit dem Update als kind new', () => {
    const parsed = parseManifestV0101(publishedManifest())
    const bundle = selectBundleV0101(parsed, ctx())
    expect(bundle?.app?.version).toBe('1.0.0')
    expect(bundle?.models.map((m) => [m.id, m.kind])).toEqual([[SEARCH_ID, 'new']])
  })

  it('dasselbe mit Schema und Auswahl dieser Version', () => {
    const bundle = selectBundle(parseManifest(publishedManifest()), ctx())
    expect(bundle?.models.map((m) => [m.id, m.kind])).toEqual([[SEARCH_ID, 'new']])
  })

  it('eine App, die es selbst nachlädt, nimmt es nicht ins Update (kein doppelter Download)', () => {
    const local: LocalLayout[] = [
      ...LAYOUTS_WITHOUT_SEARCH,
      {
        id: SEARCH_ID,
        relativePath: search.relativePath,
        checkPath: search.checkPath,
        archive: true,
        required: true
      }
    ]
    const bundle = selectBundle(parseManifest(publishedManifest()), {
      ...ctx({ currentVersion: '0.11.0', localLayouts: local }),
      selfProvisionedIds: new Set([SEARCH_ID])
    })
    expect(bundle?.models ?? []).toEqual([])
  })

  it('mit published: false steht es gar nicht im Manifest', () => {
    const manifest = buildManifest({
      catalog: MODEL_DEFINITIONS.map((m) => (m.id === SEARCH_ID ? { ...m, published: false } : m)),
      live: {},
      appVersion: '1.0.0',
      dmg,
      now: new Date()
    })
    expect(
      parseManifestV0101(JSON.parse(JSON.stringify(manifest))).models.map((m) => m.id)
    ).not.toContain(SEARCH_ID)
  })
})
