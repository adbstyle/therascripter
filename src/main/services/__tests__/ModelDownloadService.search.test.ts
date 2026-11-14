import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { sent, electronApp } = vi.hoisted(() => ({
  sent: [] as Array<[string, unknown]>,
  electronApp: { getPath: () => '/tmp/ts', isPackaged: false }
}))
vi.mock('electron', () => ({
  app: electronApp,
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (c: string, d: unknown) => sent.push([c, d]) } }]
  }
}))

vi.mock('../../db/connection', () => ({ getDataDir: () => '/tmp/ts' }))

interface Store {
  activeModels: Record<string, string | null>
  modelsDownloaded: boolean
  reconcileEvents: unknown[]
}
let store: Store
const settings = {
  get: vi.fn((key: keyof Store) => store[key]),
  set: vi.fn((key: keyof Store, value: never) => {
    store = { ...store, [key]: value }
  })
}
vi.mock('../SettingsService', () => ({ getSettings: () => settings, initSettings: () => settings }))

const installedVersions = new Map<string, unknown>()
vi.mock('../InstalledVersionsStore', () => ({
  setInstalledVersion: (id: string, v: unknown) => installedVersions.set(id, v),
  deleteInstalledVersion: (id: string) => installedVersions.delete(id)
}))

let files: Set<string>
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((p: string) => files.has(p)),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmSync: vi.fn()
  }
  return { ...fsMock, default: fsMock }
})

const downloadFile = vi.fn()
const verifyFileSha256 = vi.fn()
const extractTarGz = vi.fn()
vi.mock('../DownloadService', () => ({
  downloadFile: (...a: unknown[]) => downloadFile(...a),
  verifyFileSha256: (...a: unknown[]) => verifyFileSha256(...a),
  extractTarGz: (...a: unknown[]) => extractTarGz(...a)
}))

import { MODEL_DEFINITIONS } from '../../../shared/model-catalog'
import {
  checkModelsExist,
  checkRequiredAndActiveExist,
  classifyDownloadError,
  deleteModel,
  downloadSingleModel,
  getActiveModelIdBelief,
  getModelById,
  getModelsByGroup,
  getModelsToLoadOnFirstLaunch,
  getRequiredModels,
  getSearchModelLocation,
  installCatalogModel,
  isModelDownloadRunning,
  isSearchModelInstalled,
  reconcileActiveModels,
  startModelDownload
} from '../ModelDownloadService'

const MODELS = '/tmp/ts/models'
const SEARCH_ID = 'embeddinggemma-2-text'
const search = MODEL_DEFINITIONS.find((m) => m.id === SEARCH_ID)!
const READY = join(MODELS, 'search/embeddinggemma-2-text-v1/READY')

/** Alle übrigen Ersteinrichtungs-Modelle liegen da — ein Bestandsnutzer. */
function existingInstall(): void {
  for (const m of MODEL_DEFINITIONS) {
    if (m.group !== 'search' && (m.isRequired || m.id === 'whisper-large-v3-turbo')) {
      files.add(join(MODELS, m.checkPath))
    }
  }
}

beforeEach(() => {
  files = new Set()
  sent.length = 0
  installedVersions.clear()
  electronApp.isPackaged = false
  delete process.env.THERASCRIPT_SEARCH_MODEL_DIR
  store = {
    activeModels: {
      transcription: 'whisper-large-v3-turbo',
      diarization: 'pyannote-suite',
      diarizationPipeline: 'pyannote/speaker-diarization-3.1',
      ner: 'flair-ner-german-large',
      ocr: 'apple-vision',
      summarization: null
    },
    modelsDownloaded: true,
    reconcileEvents: []
  }
  downloadFile.mockReset()
  verifyFileSha256.mockReset()
  extractTarGz.mockReset()
})

afterEach(() => {
  search.published = false
  delete process.env.THERASCRIPT_SEARCH_MODEL_DIR
})

describe('Suchmodell — Schalter «noch nicht veröffentlicht»', () => {
  it('published: false — für alle Laufzeit-Zugriffe unsichtbar, Ersteinrichtung unverändert', () => {
    search.published = false
    expect(getModelById(SEARCH_ID)).toBeNull()
    expect(getModelsByGroup('search')).toEqual([])
    expect(getRequiredModels().map((m) => m.id)).not.toContain(SEARCH_ID)
    expect(getModelsToLoadOnFirstLaunch('whisper-large-v3-turbo').map((m) => m.id)).toEqual([
      'whisper-large-v3-turbo',
      'pyannote-suite',
      'flair-ner-german-large'
    ])
  })

  it('veröffentlicht — die Ersteinrichtung lädt es mit, als letztes (#209 AK 21)', () => {
    search.published = true
    expect(getModelById(SEARCH_ID)?.group).toBe('search')
    expect(getModelsToLoadOnFirstLaunch('whisper-large-v3-turbo').map((m) => m.id)).toEqual([
      'whisper-large-v3-turbo',
      'pyannote-suite',
      'flair-ner-german-large',
      SEARCH_ID
    ])
  })

  it.each([false, true])(
    'fehlt nur das Suchmodell, gilt die Einrichtung als vollständig (published=%s, #210 AK 3)',
    (published) => {
      search.published = published
      existingInstall()
      expect(checkRequiredAndActiveExist('whisper-large-v3-turbo', 'pyannote-suite')).toBe(true)
      expect(checkModelsExist()).toBe(true)
    }
  )

  it('fehlt ein anderes Pflichtmodell, bleibt die Einrichtung unvollständig', () => {
    search.published = true
    existingInstall()
    files.delete(join(MODELS, 'ner/hf/hub/models--xlm-roberta-large'))
    expect(checkModelsExist()).toBe(false)
  })
})

describe('Suchmodell — Ort und «installiert»', () => {
  it('von Hand am checkPath entpackt zählt als installiert, auch unveröffentlicht', () => {
    search.published = false
    expect(isSearchModelInstalled()).toBe(false)
    files.add(READY)
    expect(isSearchModelInstalled()).toBe(true)
    expect(getSearchModelLocation()).toMatchObject({
      dir: join(MODELS, 'search/embeddinggemma-2-text-v1'),
      overridden: false
    })
  })

  it('THERASCRIPT_SEARCH_MODEL_DIR übersteuert den Ort in der Entwicklung', () => {
    process.env.THERASCRIPT_SEARCH_MODEL_DIR = '/dev/eg2'
    files.add('/dev/eg2/READY')
    expect(getSearchModelLocation()).toMatchObject({
      dir: '/dev/eg2',
      readyPath: '/dev/eg2/READY',
      overridden: true
    })
    expect(isSearchModelInstalled()).toBe(true)
  })

  it('in der gepackten App gilt die Umgebungsvariable nie', () => {
    electronApp.isPackaged = true
    process.env.THERASCRIPT_SEARCH_MODEL_DIR = '/dev/eg2'
    files.add('/dev/eg2/READY')
    expect(getSearchModelLocation()?.overridden).toBe(false)
    expect(isSearchModelInstalled()).toBe(false)
  })
})

describe('Gruppe search ohne Slot', () => {
  it('hat kein aktives Modell und wirft nicht', () => {
    expect(getActiveModelIdBelief('search')).toBeNull()
  })

  it('der Reconciler lässt die Gruppe aus — kein Event, kein Wurf', () => {
    search.published = true
    existingInstall()
    expect(() => reconcileActiveModels()).not.toThrow()
    expect(store.reconcileEvents).toEqual([])
  })

  it('Löschen und Einzel-Download verweigern das Suchmodell', async () => {
    search.published = true
    files.add(READY)
    await expect(deleteModel(SEARCH_ID)).rejects.toThrow(/nicht löschbar/)
    await expect(downloadSingleModel(SEARCH_ID)).rejects.toThrow(/Pflicht-Modell/)
  })
})

describe('Ersteinrichtung mit Suchmodell', () => {
  const ok = { success: true, sha256: search.sha256 }

  it('scheitert nur das Suchmodell, öffnet sich die App trotzdem', async () => {
    search.published = true
    existingInstall()
    store.modelsDownloaded = false
    downloadFile.mockResolvedValue({ success: false, error: 'getaddrinfo ENOTFOUND' })
    await startModelDownload()
    expect(sent.at(-1)).toEqual(['modelDownload:status', { state: 'complete' }])
    expect(store.modelsDownloaded).toBe(true)
    expect(isModelDownloadRunning()).toBe(false)
  })

  it('scheitert ein anderes Pflichtmodell, bleibt es beim Fehler', async () => {
    search.published = true
    existingInstall()
    files.delete(join(MODELS, 'ner/hf/hub/models--xlm-roberta-large'))
    store.modelsDownloaded = false
    downloadFile.mockResolvedValue({ success: false, error: 'HTTP 503' })
    await startModelDownload()
    expect(sent.at(-1)).toEqual([
      'modelDownload:status',
      { state: 'error', error: 'HTTP 503', modelId: 'flair-ner-german-large' }
    ])
    expect(store.modelsDownloaded).toBe(false)
  })

  it('lädt das Suchmodell mit und trägt seine Fassung ein', async () => {
    search.published = true
    existingInstall()
    downloadFile.mockResolvedValue(ok)
    extractTarGz.mockImplementation(async () => {
      files.add(READY)
      return { success: true }
    })
    await startModelDownload()
    expect(downloadFile).toHaveBeenCalledWith(
      search.url,
      join(MODELS, `${SEARCH_ID}.tar.gz`),
      expect.any(Function),
      expect.anything()
    )
    expect(installedVersions.get(SEARCH_ID)).toMatchObject({ sha256: search.sha256 })
    expect(sent.at(-1)).toEqual(['modelDownload:status', { state: 'complete' }])
  })

  it('unveröffentlicht: kein Download-Versuch', async () => {
    search.published = false
    existingInstall()
    await startModelDownload()
    expect(downloadFile).not.toHaveBeenCalled()
  })
})

describe('installCatalogModel', () => {
  const signal = { aborted: false }

  it('zählt nicht als Modell-Download im WorkGuard', async () => {
    let finish: (v: unknown) => void = () => {}
    downloadFile.mockReturnValue(new Promise((r) => (finish = r)))
    const running = installCatalogModel(search, { signal })
    expect(isModelDownloadRunning()).toBe(false)
    finish({ success: false, error: 'Aborted' })
    expect(await running).toEqual({ ok: false, reason: 'aborted', error: 'Aborted' })
  })

  it.each([
    ['getaddrinfo ENOTFOUND pub.r2.dev', 'network'],
    ['HTTP 404', 'network'],
    ['Connection timeout', 'network'],
    ['ENOSPC: no space left on device, write', 'disk-space'],
    ['Datei konnte nicht finalisiert werden: EACCES', 'unknown'],
    ['Aborted', 'aborted']
  ])('ordnet «%s» dem Grund %s zu', (error, reason) => {
    expect(classifyDownloadError(error)).toBe(reason)
  })

  it('falsche Prüfsumme: Datei weg, Grund checksum', async () => {
    downloadFile.mockResolvedValue({ success: true, sha256: 'f'.repeat(64) })
    const result = await installCatalogModel(search, { signal })
    expect(result).toMatchObject({ ok: false, reason: 'checksum' })
    expect(extractTarGz).not.toHaveBeenCalled()
  })

  it('Entpacken scheitert: Grund extract, bei vollem Datenträger disk-space', async () => {
    downloadFile.mockResolvedValue({ success: true, sha256: search.sha256 })
    extractTarGz.mockResolvedValueOnce({ success: false, error: 'Extraction fehlgeschlagen: x' })
    expect(await installCatalogModel(search, { signal })).toMatchObject({ reason: 'extract' })
    extractTarGz.mockResolvedValueOnce({
      success: false,
      error: 'Extraction fehlgeschlagen: tar: Write error: No space left on device'
    })
    expect(await installCatalogModel(search, { signal })).toMatchObject({ reason: 'disk-space' })
  })

  it('ohne READY nach dem Entpacken: ok, aber nicht installiert und nicht eingetragen', async () => {
    downloadFile.mockResolvedValue({ success: true, sha256: search.sha256 })
    extractTarGz.mockResolvedValue({ success: true })
    expect(await installCatalogModel(search, { signal })).toEqual({ ok: true, installed: false })
    expect(installedVersions.has(SEARCH_ID)).toBe(false)
  })
})
