import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppUpdateService,
  IDLE_INSTALL_SECONDS,
  MAX_SILENT_INSTALL_ATTEMPTS,
  previousBundlePath,
  readPersistedUpdate,
  type AppUpdateDeps,
  type PersistedUpdate,
  type UpdateSource
} from '../AppUpdateService'
import { stagePaths } from '../model-staging'
import type { BusyReason } from '../WorkGuard'
import type { LocalLayout } from '../../../shared/update-bundle'
import type {
  BundleModel,
  ManifestModelInput
} from '../../../shared/validation/model-update-schemas'

const SHA = 'a'.repeat(64)
const offer = (version: string, sha256 = SHA) => ({
  version,
  url: `https://github.com/x/releases/download/v${version}/Therascript.dmg`,
  sha256,
  sizeBytes: 1000
})
const appOnly = (version: string): UpdateSource => ({ app: offer(version), models: [] })

// Zwei installierte Modelle: ein Archiv (ner) und eine Datei (asr)
const LOCAL: LocalLayout[] = [
  { id: 'ner', relativePath: 'ner', checkPath: 'ner/model', archive: true, required: true },
  { id: 'asr', relativePath: 'asr/a.bin', checkPath: 'asr/a.bin', archive: false, required: false }
]
const modelEntry = (
  id: string,
  sha256: string,
  over: Partial<ManifestModelInput> = {}
): ManifestModelInput => ({
  id,
  version: '2026-10-12',
  label: id.toUpperCase(),
  url: `https://cdn/${id}`,
  sha256,
  sizeBytes: 500,
  ...over
})
const NEW_NER = 'b'.repeat(64)
const NEW_ASR = 'c'.repeat(64)

let root: string
let persisted: PersistedUpdate | null
let autoUpdate: boolean
let work: BusyReason | null
let idle: number
let installed: Record<string, string>
let deps: AppUpdateDeps & {
  quitApp: ReturnType<typeof vi.fn>
  relaunch: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  stageModel: ReturnType<typeof vi.fn>
  setStartHidden: ReturnType<typeof vi.fn>
}

const modelsDir = (): string => join(root, 'models')
const readModel = (path: string): string => readFileSync(join(modelsDir(), path), 'utf8')

function makeDeps(over: Partial<AppUpdateDeps> = {}): typeof deps {
  const bundle = join(root, 'Applications', 'Therascript.app')
  mkdirSync(bundle, { recursive: true })
  if (!existsSync(join(bundle, 'version'))) writeFileSync(join(bundle, 'version'), 'old')
  return {
    currentVersion: '1.0.0',
    isPackaged: true,
    bundlePath: bundle,
    workDir: join(root, 'app-update'),
    modelsDir: modelsDir(),
    selfReplaceBlocker: () => null,
    setupComplete: () => true,
    localLayouts: () => LOCAL,
    retiredIds: () => new Set(),
    installedSha: (id) => installed[id] ?? null,
    recordInstalledModel: (m) => {
      installed[m.id] = m.sha256
    },
    getAutoUpdate: () => autoUpdate,
    setAutoUpdate: (v) => {
      autoUpdate = v
    },
    readPersisted: () => persisted,
    writePersisted: (v) => {
      persisted = v
    },
    setStartHidden: vi.fn(),
    download: vi.fn(async (_url, target: string, onProgress: (p: number) => void) => {
      onProgress(50)
      writeFileSync(target, 'dmg')
      return { success: true }
    }),
    sha256OfFile: async () => SHA,
    freeBytes: () => 100 * 1024 ** 3,
    extractApp: async (_dmg, targetApp) => {
      mkdirSync(targetApp, { recursive: true })
      writeFileSync(join(targetApp, 'version'), 'new')
    },
    verifyApp: async () => undefined,
    // Wie model-staging.stageModel: am Ende liegt ein fertiger payload
    stageModel: vi.fn(async (m: BundleModel) => {
      const { payload } = stagePaths(modelsDir(), m)
      if (m.archive) {
        mkdirSync(payload, { recursive: true })
        writeFileSync(join(payload, 'model'), `new ${m.id}`)
      } else {
        mkdirSync(join(payload, '..'), { recursive: true })
        writeFileSync(payload, `new ${m.id}`)
      }
    }),
    currentWork: () => work,
    idleSeconds: () => idle,
    isWindowVisible: () => true,
    quitApp: vi.fn(),
    relaunch: vi.fn(),
    onStateChange: () => undefined,
    removeInBackground: (path) => rmSync(path, { recursive: true, force: true }),
    removeNow: async (path) => rmSync(path, { recursive: true, force: true }),
    log: () => undefined,
    now: () => new Date('2026-10-12T10:00:00Z'),
    ...over
  } as typeof deps
}

async function readyService(
  source: UpdateSource = appOnly('1.1.0'),
  over: Partial<AppUpdateDeps> = {}
): Promise<AppUpdateService> {
  deps = makeDeps(over)
  const service = new AppUpdateService(deps)
  service.handleManifest(source)
  await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
  return service
}

/** Beenden mit Austausch, danach der nächste Start (der neuen Version). */
function quitAndRestart(service: AppUpdateService, newVersion = '1.0.0'): AppUpdateService {
  service.performQuitInstall(service.prepareQuitInstall()!)
  const restarted = new AppUpdateService({ ...deps, currentVersion: newVersion })
  restarted.init()
  return restarted
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-update-test-'))
  mkdirSync(join(root, 'models', 'ner'), { recursive: true })
  writeFileSync(join(root, 'models', 'ner', 'model'), 'old ner')
  mkdirSync(join(root, 'models', 'asr'), { recursive: true })
  writeFileSync(join(root, 'models', 'asr', 'a.bin'), 'old asr')
  installed = { ner: SHA, asr: SHA }
  persisted = null
  autoUpdate = true
  work = null
  idle = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AppUpdateService — Angebot und Download', () => {
  it('lädt eine neuere Version automatisch und stellt sie geprüft bereit', async () => {
    const service = await readyService()
    expect(service.getState()).toMatchObject({ version: '1.1.0', progress: null, message: null })
    expect(persisted?.app?.stagedAppPath).toMatch(/1\.1\.0-a{12}\/Therascript\.app$/)
  })

  it('bietet gleiche oder ältere Versionen nicht an (AK 11)', () => {
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.0.0'))
    service.handleManifest(appOnly('0.9.0'))
    expect(service.getState().phase).toBe('idle')
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('lädt bei ausgeschalteten automatischen Updates nur auf Klick (#165)', async () => {
    autoUpdate = false
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    expect(service.getState()).toMatchObject({
      phase: 'available',
      version: '1.1.0',
      sizeBytes: 1000
    })
    expect(deps.download).not.toHaveBeenCalled()

    await service.download({ manual: true })
    expect(service.getState().phase).toBe('ready')
  })

  it('lädt automatisch nur, wenn danach 5 GB frei bleiben (AK 12) — und sagt es', () => {
    deps = makeDeps({ freeBytes: () => 5 * 1024 ** 3 })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    expect(service.getState().phase).toBe('available')
    expect(service.getState().message).toMatch(/fehlt Speicherplatz/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('meldet einen automatischen Download nicht erst als «verfügbar» (kein Aufblitzen)', async () => {
    const phases: string[] = []
    deps = makeDeps({ onStateChange: (s) => phases.push(s.phase) })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    expect(phases).not.toContain('available')
  })

  it('merkt sich eine gescheiterte Prüfung bis zur nächsten gelungenen', () => {
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleCheckFailed()
    expect(service.getState()).toMatchObject({ checkFailed: true, checkedAt: null })
    service.handleManifest({ models: [] })
    expect(service.getState()).toMatchObject({ checkFailed: false, phase: 'idle' })
    expect(service.getState().checkedAt).not.toBeNull()
  })

  it('verwirft eine Datei, die nicht zur signierten Beschreibung passt — still im Hintergrund', async () => {
    deps = makeDeps({ sha256OfFile: async () => 'b'.repeat(64) })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalled())
    await vi.waitFor(() => expect(service.getState().phase).toBe('available'))
    expect(service.getState().message).toBeNull()
  })

  it('meldet den Fehler eines selbst gestarteten Downloads mit nächstem Schritt', async () => {
    autoUpdate = false
    deps = makeDeps({ sha256OfFile: async () => 'b'.repeat(64) })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    await service.download({ manual: true })
    expect(service.getState().phase).toBe('available')
    expect(service.getState().message).toMatch(/später erneut/)
  })

  it('zeigt den Fortschritt nur bei einem selbst gestarteten Download', async () => {
    autoUpdate = false
    let seen: number | null = null
    deps = makeDeps({
      download: vi.fn(async (_u, target: string, onProgress: (p: number) => void) => {
        onProgress(42)
        seen = service.getState().progress
        writeFileSync(target, 'dmg')
        return { success: true }
      })
    })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    await service.download({ manual: true })
    expect(seen).toBe(42)
  })

  it('ersetzt ein bereitliegendes Update durch eine neuere Version', async () => {
    const service = await readyService()
    service.handleManifest(appOnly('1.2.0'))
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ phase: 'ready', version: '1.2.0' })
    )
  })

  it('löscht beim Ersetzen nie in den Ordner des neuen Downloads hinein', async () => {
    // Das Löschen läuft erst «später» — wie rm im Hintergrund
    const pending: string[] = []
    const service = await readyService(appOnly('1.1.0'), {
      removeInBackground: (path) => pending.push(path)
    })
    service.handleManifest(appOnly('1.2.0'))
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    for (const path of pending) rmSync(path, { recursive: true, force: true })
    expect(existsSync(persisted!.app!.stagedAppPath!)).toBe(true)
    expect(persisted!.app!.stagedAppPath).toMatch(/1\.2\.0-a{12}\/Therascript\.app$/)
  })

  it('startet nach einem Abbruch erst, wenn der abgebrochene Lauf aufgeräumt hat', async () => {
    autoUpdate = false
    let releaseExtract: () => void = () => undefined
    const order: string[] = []
    let calls = 0
    deps = makeDeps({
      extractApp: async (_dmg, targetApp, signal) => {
        const call = ++calls
        order.push(`extract ${call}`)
        if (call === 1) {
          await new Promise<void>((resolve) => (releaseExtract = resolve))
          expect(signal.aborted).toBe(true)
          order.push('extract 1 aufgeräumt')
          return
        }
        mkdirSync(targetApp, { recursive: true })
      }
    })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    const first = service.download({ manual: true })
    await vi.waitFor(() => expect(order).toEqual(['extract 1']))
    service.cancelDownload()
    const second = service.download({ manual: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['extract 1'])
    releaseExtract()
    await Promise.all([first, second])
    expect(order).toEqual(['extract 1', 'extract 1 aufgeräumt', 'extract 2'])
    expect(service.getState().phase).toBe('ready')
  })

  it('verweist auf die Website, wenn sich die App nicht ersetzen kann (AK 9)', () => {
    deps = makeDeps({ selfReplaceBlocker: () => 'Therascript läuft nicht aus «Programme».' })
    const service = new AppUpdateService(deps)
    service.handleManifest(appOnly('1.1.0'))
    expect(service.getState()).toMatchObject({
      phase: 'unsupported',
      version: '1.1.0',
      manualVersion: '1.1.0',
      unsupportedReason: 'Therascript läuft nicht aus «Programme».'
    })
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('behält beim Ausschalten ein bereitliegendes Update (#165 PC 2)', async () => {
    const service = await readyService()
    service.setAutoUpdate(false)
    expect(service.getState()).toMatchObject({ phase: 'ready', autoUpdate: false })
  })
})

describe('AppUpdateService — App und Modelle als ein Vorgang (#167)', () => {
  const both: UpdateSource = {
    app: offer('1.1.0'),
    models: [modelEntry('ner', NEW_NER), modelEntry('asr', NEW_ASR)]
  }

  it('lädt App und Modelle zusammen und nennt die gesamte Grösse (AK 1, AK 3)', async () => {
    autoUpdate = false
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest(both)
    expect(service.getState()).toMatchObject({
      phase: 'available',
      version: '1.1.0',
      sizeBytes: 2000,
      appSizeBytes: 1000,
      models: [
        { id: 'ner', label: 'NER', sizeBytes: 500, kind: 'update' },
        { id: 'asr', label: 'ASR', sizeBytes: 500, kind: 'update' }
      ]
    })
    // Speicherbedarf vor dem Start: App ×5, Archiv ×2.5, Datei ×1
    expect(service.getState().diskNeedBytes).toBe(5000 + 1250 + 500)
    await service.download({ manual: true })
    expect(service.getState().phase).toBe('ready')
    expect(deps.stageModel).toHaveBeenCalledTimes(2)
  })

  it('installiert alles mit einem Neustart und trägt die Modelle erst danach ein', async () => {
    const service = await readyService(both)
    service.requestInstall()
    expect(deps.quitApp).toHaveBeenCalledOnce()
    expect(installed.ner).toBe(SHA)

    const restarted = quitAndRestart(service, '1.1.0')
    expect(deps.relaunch).toHaveBeenCalledOnce()
    expect(readFileSync(join(deps.bundlePath, 'version'), 'utf8')).toBe('new')
    expect(readModel('ner/model')).toBe('new ner')
    expect(readModel('asr/a.bin')).toBe('new asr')
    expect(installed).toEqual({ ner: NEW_NER, asr: NEW_ASR })
    expect(persisted).toBeNull()
    expect(restarted.getState().phase).toBe('idle')
  })

  it('läuft ein reines Modell-Update gleich ab — mit Neustart (AK 2)', async () => {
    const service = await readyService({ models: [modelEntry('ner', NEW_NER)] })
    expect(service.getState()).toMatchObject({ version: null, sizeBytes: 500 })
    idle = IDLE_INSTALL_SECONDS
    service.tick()
    expect(deps.quitApp).toHaveBeenCalledOnce()
    quitAndRestart(service)
    expect(deps.relaunch).toHaveBeenCalledOnce()
    expect(readModel('ner/model')).toBe('new ner')
    expect(installed.ner).toBe(NEW_NER)
  })

  it('bietet nur Modelle an, die zur installierten Version passen (AK 6)', () => {
    autoUpdate = false
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest({
      models: [modelEntry('ner', NEW_NER, { minAppVersion: '1.1.0' }), modelEntry('asr', NEW_ASR)]
    })
    expect(service.getState().models.map((m) => m.id)).toEqual(['asr'])
  })

  it('bringt ein Pflichtmodell der neuen Version im selben Vorgang mit (AK 4)', async () => {
    const vad = modelEntry('vad', 'd'.repeat(64), {
      relativePath: 'vad',
      checkPath: 'vad/model',
      archive: true,
      required: true,
      minAppVersion: '1.1.0'
    })
    const service = await readyService({ app: offer('1.1.0'), models: [vad] })
    expect(service.getState().models).toEqual([expect.objectContaining({ id: 'vad', kind: 'new' })])
    quitAndRestart(service, '1.1.0')
    expect(readModel('vad/model')).toBe('new vad')
  })

  it('stellt Modelle bereit, auch wenn die App von Hand installiert werden muss', async () => {
    const service = await readyService(both, { selfReplaceBlocker: () => 'Nicht in «Programme».' })
    expect(service.getState()).toMatchObject({
      phase: 'ready',
      version: null,
      manualVersion: '1.1.0',
      unsupportedReason: 'Nicht in «Programme».'
    })
    expect(service.getState().models.map((m) => m.id)).toEqual(['ner', 'asr'])
  })

  it('alles oder nichts: scheitert ein Teil beim Laden, wird nichts installiert', async () => {
    deps = makeDeps({
      stageModel: vi.fn(async () => {
        throw new Error('HTTP 500')
      })
    })
    const service = new AppUpdateService(deps)
    service.handleManifest(both)
    await vi.waitFor(() => expect(service.getState().phase).toBe('available'))
    expect(service.prepareQuitInstall()).toBeNull()
  })

  it('alles oder nichts: scheitert der App-Tausch, kommen auch die Modelle zurück (PC 2)', async () => {
    const service = await readyService(both)
    // Die bereitgestellte App verschwindet nach der Vorprüfung — ihr Tausch scheitert
    const staged = persisted!.app!.stagedAppPath!
    const plan = service.prepareQuitInstall()!
    const write = deps.writePersisted
    deps.writePersisted = (v) => {
      write(v)
      if (v?.installAttemptedAt) rmSync(staged, { recursive: true, force: true })
    }
    service.performQuitInstall(plan)
    expect(readFileSync(join(deps.bundlePath, 'version'), 'utf8')).toBe('old')
    expect(readModel('ner/model')).toBe('old ner')
    expect(readModel('asr/a.bin')).toBe('old asr')
  })

  it('nach einem Absturz mitten im Tausch stellt der nächste Start den alten Stand her', async () => {
    await readyService({ models: [modelEntry('ner', NEW_NER), modelEntry('asr', NEW_ASR)] })
    // Absturz: Merker gesetzt, ner schon getauscht, asr noch nicht
    persisted = { ...persisted!, installAttemptedAt: '2026-10-12T10:00:00Z' }
    const ner = stagePaths(modelsDir(), persisted.models[0])
    mkdirSync(join(ner.backup, '..'), { recursive: true })
    renameSync(ner.final, ner.backup)
    renameSync(ner.payload, ner.final)

    const restarted = new AppUpdateService(makeDeps())
    restarted.init()
    expect(readModel('ner/model')).toBe('old ner')
    expect(installed.ner).toBe(SHA)
    expect(restarted.getState().phase).toBe('ready')
    expect(restarted.getState().message).toMatch(/nicht gelungen/)
  })

  it('ein in den Einstellungen gelöschtes Modell fällt aus dem Update', async () => {
    const service = await readyService({
      models: [modelEntry('ner', NEW_NER), modelEntry('asr', NEW_ASR)]
    })
    rmSync(join(modelsDir(), 'asr'), { recursive: true })
    service.handleModelsChanged()
    expect(service.getState().models.map((m) => m.id)).toEqual(['ner'])
    expect(existsSync(stagePaths(modelsDir(), persisted!.models[0]).payload)).toBe(true)
    expect(existsSync(join(modelsDir(), '.update', NEW_ASR))).toBe(false)
  })

  it('ein Modell-Download in den Einstellungen pausiert das Bereitstellen', async () => {
    deps = makeDeps({
      stageModel: vi.fn(async (m: BundleModel, _p, signal: AbortSignal) => {
        if (deps.stageModel.mock.calls.length === 1) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          throw new Error('Abgebrochen')
        }
        mkdirSync(stagePaths(modelsDir(), m).payload, { recursive: true })
      })
    })
    const service = new AppUpdateService(deps)
    service.handleManifest({ models: [modelEntry('ner', NEW_NER)] })
    await vi.waitFor(() => expect(deps.stageModel).toHaveBeenCalledOnce())

    let duringPause = ''
    await service.withStagingPaused(async () => {
      duringPause = service.getState().phase
    })
    expect(duringPause).toBe('available')
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    expect(deps.stageModel).toHaveBeenCalledTimes(2)
  })
})

describe('AppUpdateService — Rücksicht auf laufende Arbeit (#167)', () => {
  it('lädt im Hintergrund nicht während einer Aufnahme und holt es danach nach', async () => {
    work = 'recording'
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest({ models: [modelEntry('ner', NEW_NER)] })
    expect(service.getState().phase).toBe('available')
    expect(deps.stageModel).not.toHaveBeenCalled()

    service.tick()
    expect(deps.stageModel).not.toHaveBeenCalled()
    work = null
    service.tick()
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
  })

  it('pausiert einen Hintergrund-Download, sobald eine Verarbeitung beginnt', async () => {
    deps = makeDeps({
      stageModel: vi.fn(async (m: BundleModel, _p, signal: AbortSignal) => {
        if (deps.stageModel.mock.calls.length === 1) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          throw new Error('Abgebrochen')
        }
        mkdirSync(stagePaths(modelsDir(), m).payload, { recursive: true })
      })
    })
    const service = new AppUpdateService(deps)
    service.handleManifest({ models: [modelEntry('ner', NEW_NER)] })
    await vi.waitFor(() => expect(deps.stageModel).toHaveBeenCalledOnce())

    work = 'processing'
    service.tick()
    expect(service.getState().phase).toBe('available')
    work = null
    service.tick()
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
  })

  it('setzt einen selbst gestarteten Download nach einem Modell-Download in den Einstellungen fort', async () => {
    autoUpdate = false
    deps = makeDeps({
      stageModel: vi.fn(async (m: BundleModel, _p, signal: AbortSignal) => {
        if (deps.stageModel.mock.calls.length === 1) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          throw new Error('Abgebrochen')
        }
        mkdirSync(stagePaths(modelsDir(), m).payload, { recursive: true })
      })
    })
    const service = new AppUpdateService(deps)
    service.handleManifest({ models: [modelEntry('ner', NEW_NER)] })
    void service.download({ manual: true })
    await vi.waitFor(() => expect(deps.stageModel).toHaveBeenCalledOnce())

    await service.withStagingPaused(async () => undefined)
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    expect(deps.stageModel).toHaveBeenCalledTimes(2)
  })

  it('setzt bei neu veröffentlichter gleicher Version keinen alten Download fort', async () => {
    const service = await readyService(appOnly('1.1.0'))
    const first = persisted!.app!.stagedAppPath!
    service.handleManifest({ app: offer('1.1.0', 'e'.repeat(64)), models: [] })
    await vi.waitFor(() => expect(persisted?.app?.sha256).toBe('e'.repeat(64)))
    expect(persisted!.app!.stagedAppPath ?? '').not.toBe(first)
  })
})

describe('AppUpdateService — Installieren', () => {
  it('installiert auf Klick sofort, wenn nichts läuft — mit Neustart', async () => {
    const service = await readyService()
    expect(service.requestInstall()).toEqual({ status: 'installing' })
    expect(deps.quitApp).toHaveBeenCalledOnce()
    expect(service.prepareQuitInstall()).toEqual({ relaunch: true, startHidden: false })
  })

  it('merkt die Installation während einer Aufnahme vor und holt sie danach nach (AK 15, PC 9)', async () => {
    const service = await readyService()
    work = 'recording'
    expect(service.requestInstall()).toEqual({ status: 'pending', reason: 'recording' })
    expect(service.getState().message).toMatch(/Aufnahme beendet/)
    service.tick()
    expect(deps.quitApp).not.toHaveBeenCalled()

    work = null
    service.tick()
    expect(deps.quitApp).toHaveBeenCalledOnce()
  })

  it('installiert nach 10 Minuten ohne Eingabe selbständig (AK 7)', async () => {
    const service = await readyService()
    idle = IDLE_INSTALL_SECONDS - 1
    service.tick()
    expect(deps.quitApp).not.toHaveBeenCalled()
    idle = IDLE_INSTALL_SECONDS
    service.tick()
    expect(deps.quitApp).toHaveBeenCalledOnce()
  })

  it('installiert nie während laufender Verarbeitung, auch nicht im Leerlauf (AK 14)', async () => {
    const service = await readyService()
    idle = IDLE_INSTALL_SECONDS * 2
    work = 'processing'
    service.tick()
    expect(deps.quitApp).not.toHaveBeenCalled()
  })

  it('installiert ohne automatische Updates nie selbständig (#165 PC 1)', async () => {
    const service = await readyService()
    service.setAutoUpdate(false)
    idle = IDLE_INSTALL_SECONDS * 2
    service.tick()
    expect(deps.quitApp).not.toHaveBeenCalled()
    expect(service.prepareQuitInstall()).toBeNull()
  })

  it('installiert beim Beenden ohne Neustart — aber nicht, wenn etwas läuft (AK 13/14)', async () => {
    const service = await readyService()
    work = 'recording'
    expect(service.prepareQuitInstall()).toBeNull()
    work = null
    expect(service.prepareQuitInstall()).toEqual({ relaunch: false, startHidden: false })
  })

  it('friert das Update während des Beendens ein — eine späte Prüfung räumt nichts weg', async () => {
    const service = await readyService()
    service.prepareQuitInstall()
    service.handleManifest(appOnly('1.2.0'))
    expect(persisted?.app?.version).toBe('1.1.0')
    expect(existsSync(persisted!.app!.stagedAppPath!)).toBe(true)
  })

  it('merkt sich ein verstecktes Fenster für den Neustart (PC 7)', async () => {
    const service = await readyService(appOnly('1.1.0'), { isWindowVisible: () => false })
    service.requestInstall()
    const plan = service.prepareQuitInstall()!
    service.performQuitInstall(plan)
    expect(deps.setStartHidden).toHaveBeenCalledWith(true)
  })

  it('tauscht die App durch Umbenennen und startet neu', async () => {
    const service = await readyService()
    service.requestInstall()
    service.performQuitInstall(service.prepareQuitInstall()!)

    expect(readFileSync(join(deps.bundlePath, 'version'), 'utf8')).toBe('new')
    expect(readFileSync(join(previousBundlePath(deps.bundlePath), 'version'), 'utf8')).toBe('old')
    expect(persisted?.installAttemptedAt).toBeTruthy()
    expect(deps.relaunch).toHaveBeenCalledOnce()
  })

  it('lässt die bisherige Version stehen, wenn die neue fehlt (PC 4), und startet trotzdem neu', async () => {
    const service = await readyService()
    rmSync(persisted!.app!.stagedAppPath!, { recursive: true })
    service.requestInstall()
    service.performQuitInstall({ relaunch: true, startHidden: false })
    expect(readFileSync(join(deps.bundlePath, 'version'), 'utf8')).toBe('old')
    expect(deps.relaunch).toHaveBeenCalledOnce()
  })

  it('installiert nach wiederholtem Scheitern nicht mehr selbständig (keine Neustart-Schleife)', async () => {
    const service = await readyService()
    persisted = { ...persisted!, failedInstalls: MAX_SILENT_INSTALL_ATTEMPTS }
    idle = IDLE_INSTALL_SECONDS
    service.tick()
    expect(deps.quitApp).not.toHaveBeenCalled()
    expect(service.prepareQuitInstall()).toBeNull()
    expect(service.requestInstall()).toEqual({ status: 'installing' })
  })
})

describe('AppUpdateService — nach dem Neustart', () => {
  it('räumt nach gelungenem Update auf', () => {
    persisted = {
      schema: 2,
      app: { ...offer('1.1.0'), stagedAppPath: null },
      models: [],
      installAttemptedAt: '2026-10-12T09:00:00Z',
      failedInstalls: 0
    }
    deps = makeDeps({ currentVersion: '1.1.0' })
    mkdirSync(previousBundlePath(deps.bundlePath))
    new AppUpdateService(deps).init()
    expect(persisted).toBeNull()
    expect(existsSync(previousBundlePath(deps.bundlePath))).toBe(false)
  })

  it('übernimmt ein gespeichertes Update aus der Version vor #167', () => {
    deps = makeDeps({ currentVersion: '1.1.0' })
    const legacy = {
      ...offer('1.1.0'),
      stagedAppPath: null,
      installAttemptedAt: '2026-10-12T09:00:00Z',
      failedInstalls: 0
    }
    expect(readPersistedUpdate(legacy, deps.workDir)).toMatchObject({
      schema: 2,
      models: [],
      app: { version: '1.1.0' }
    })
    persisted = legacy as unknown as PersistedUpdate
    new AppUpdateService(deps).init()
    expect(persisted).toBeNull()
  })

  it('verwirft eine gespeicherte App-Kopie ausserhalb des Arbeitsordners', () => {
    deps = makeDeps()
    const record = {
      schema: 2,
      app: { ...offer('1.1.0'), stagedAppPath: '/Applications/Fremd.app' },
      models: [],
      installAttemptedAt: null,
      failedInstalls: 0
    }
    expect(readPersistedUpdate(record, deps.workDir)).toBeNull()
  })

  it('meldet eine gescheiterte Installation und bietet sie still erneut an (AK 16, PC 5)', () => {
    deps = makeDeps()
    const staged = join(root, 'app-update', '1.1.0', 'Therascript.app')
    mkdirSync(staged, { recursive: true })
    persisted = {
      schema: 2,
      app: { ...offer('1.1.0'), stagedAppPath: staged },
      models: [],
      installAttemptedAt: '2026-10-12T09:00:00Z',
      failedInstalls: 0
    }
    const service = new AppUpdateService(deps)
    service.init()
    expect(service.getState()).toMatchObject({ phase: 'ready', version: '1.1.0' })
    expect(service.getState().message).toMatch(/automatisch erneut/)
    expect(persisted).toMatchObject({ installAttemptedAt: null, failedInstalls: 1 })
  })

  it('setzt einen beim Beenden unterbrochenen Hintergrund-Download fort', async () => {
    persisted = {
      schema: 2,
      app: { ...offer('1.1.0'), stagedAppPath: null },
      models: [],
      installAttemptedAt: null,
      failedInstalls: 0
    }
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.init()
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
  })

  it('versucht keinen Austausch, wenn die App jetzt nicht aus «Programme» läuft (AK 9)', () => {
    deps = makeDeps({ selfReplaceBlocker: () => 'Therascript läuft nicht aus «Programme».' })
    const staged = join(root, 'app-update', '1.1.0', 'Therascript.app')
    mkdirSync(staged, { recursive: true })
    persisted = {
      schema: 2,
      app: { ...offer('1.1.0'), stagedAppPath: staged },
      models: [],
      installAttemptedAt: null,
      failedInstalls: 0
    }
    const service = new AppUpdateService(deps)
    service.init()
    expect(service.getState().phase).toBe('unsupported')
    expect(service.prepareQuitInstall()).toBeNull()
  })

  it('räumt beim Start liegengebliebene Lösch-Reste weg', () => {
    deps = makeDeps()
    const leftover = join(root, 'app-update.deleting-123')
    mkdirSync(leftover)
    new AppUpdateService(deps).init()
    expect(existsSync(leftover)).toBe(false)
  })

  it('stellt vor abgeschlossener Ersteinrichtung nichts bereit', () => {
    deps = makeDeps({ setupComplete: () => false })
    const service = new AppUpdateService(deps)
    service.handleManifest({ app: offer('1.1.0'), models: [modelEntry('ner', NEW_NER)] })
    expect(service.getState().phase).toBe('idle')
    expect(deps.download).not.toHaveBeenCalled()
  })
})
