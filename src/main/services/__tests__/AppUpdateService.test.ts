import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AppUpdateService,
  IDLE_INSTALL_SECONDS,
  previousBundlePath,
  type AppUpdateDeps,
  type PersistedAppUpdate
} from '../AppUpdateService'
import type { BusyReason } from '../WorkGuard'

const SHA = 'a'.repeat(64)
const offer = (version: string, sha256 = SHA) => ({
  version,
  url: `https://github.com/x/releases/download/v${version}/Therascript.dmg`,
  sha256,
  sizeBytes: 1000
})

let root: string
let persisted: PersistedAppUpdate | null
let autoUpdate: boolean
let work: BusyReason | null
let idle: number
let deps: AppUpdateDeps & {
  quitApp: ReturnType<typeof vi.fn>
  relaunch: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  setStartHidden: ReturnType<typeof vi.fn>
}

function makeDeps(over: Partial<AppUpdateDeps> = {}): typeof deps {
  const bundle = join(root, 'Applications', 'Therascript.app')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'version'), 'old')
  return {
    currentVersion: '1.0.0',
    bundlePath: bundle,
    workDir: join(root, 'app-update'),
    selfReplaceBlocker: () => null,
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

async function readyService(over: Partial<AppUpdateDeps> = {}): Promise<AppUpdateService> {
  deps = makeDeps(over)
  const service = new AppUpdateService(deps)
  service.handleManifest(offer('1.1.0'))
  await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
  return service
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-update-test-'))
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
    expect(persisted?.stagedAppPath).toMatch(/1\.1\.0\/Therascript\.app$/)
  })

  it('bietet gleiche oder ältere Versionen nicht an (AK 11)', () => {
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest(offer('1.0.0'))
    service.handleManifest(offer('0.9.0'))
    expect(service.getState().phase).toBe('idle')
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('lädt bei ausgeschalteten automatischen Updates nur auf Klick (#165)', async () => {
    autoUpdate = false
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleManifest(offer('1.1.0'))
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
    service.handleManifest(offer('1.1.0'))
    expect(service.getState().phase).toBe('available')
    expect(service.getState().message).toMatch(/fehlt Speicherplatz/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('meldet einen automatischen Download nicht erst als «verfügbar» (kein Aufblitzen)', async () => {
    const phases: string[] = []
    deps = makeDeps({ onStateChange: (s) => phases.push(s.phase) })
    const service = new AppUpdateService(deps)
    service.handleManifest(offer('1.1.0'))
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    expect(phases).not.toContain('available')
  })

  it('merkt sich eine gescheiterte Prüfung bis zur nächsten gelungenen', () => {
    deps = makeDeps()
    const service = new AppUpdateService(deps)
    service.handleCheckFailed()
    expect(service.getState()).toMatchObject({ checkFailed: true, checkedAt: null })
    service.handleManifest(undefined)
    expect(service.getState()).toMatchObject({ checkFailed: false, phase: 'idle' })
    expect(service.getState().checkedAt).not.toBeNull()
  })

  it('verwirft eine Datei, die nicht zur signierten Beschreibung passt — still im Hintergrund', async () => {
    deps = makeDeps({ sha256OfFile: async () => 'b'.repeat(64) })
    const service = new AppUpdateService(deps)
    service.handleManifest(offer('1.1.0'))
    await vi.waitFor(() => expect(deps.download).toHaveBeenCalled())
    await vi.waitFor(() => expect(service.getState().phase).toBe('available'))
    expect(service.getState().message).toBeNull()
  })

  it('meldet den Fehler eines selbst gestarteten Downloads mit nächstem Schritt', async () => {
    autoUpdate = false
    deps = makeDeps({ sha256OfFile: async () => 'b'.repeat(64) })
    const service = new AppUpdateService(deps)
    service.handleManifest(offer('1.1.0'))
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
    service.handleManifest(offer('1.1.0'))
    await service.download({ manual: true })
    expect(seen).toBe(42)
  })

  it('ersetzt ein bereitliegendes Update durch eine neuere Version', async () => {
    const service = await readyService()
    service.handleManifest(offer('1.2.0'))
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ phase: 'ready', version: '1.2.0' })
    )
  })

  it('löscht beim Ersetzen nie in den Ordner des neuen Downloads hinein', async () => {
    // Das Löschen läuft erst «später» — wie rm im Hintergrund
    const pending: string[] = []
    const service = await readyService({ removeInBackground: (path) => pending.push(path) })
    service.handleManifest(offer('1.2.0'))
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'))
    for (const path of pending) rmSync(path, { recursive: true, force: true })
    expect(existsSync(persisted!.stagedAppPath!)).toBe(true)
    expect(persisted!.stagedAppPath).toMatch(/1\.2\.0\/Therascript\.app$/)
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
    service.handleManifest(offer('1.1.0'))
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
    service.handleManifest(offer('1.1.0'))
    expect(service.getState()).toMatchObject({
      phase: 'unsupported',
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
    expect(service.prepareQuitInstall()).toEqual({ relaunch: false, startHidden: false })
    work = 'recording'
    expect(service.prepareQuitInstall()).toBeNull()
  })

  it('merkt sich ein verstecktes Fenster für den Neustart (PC 7)', async () => {
    const service = await readyService({ isWindowVisible: () => false })
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
    rmSync(persisted!.stagedAppPath!, { recursive: true })
    service.requestInstall()
    service.performQuitInstall({ relaunch: true, startHidden: false })
    expect(readFileSync(join(deps.bundlePath, 'version'), 'utf8')).toBe('old')
    expect(deps.relaunch).toHaveBeenCalledOnce()
  })
})

describe('AppUpdateService — nach dem Neustart', () => {
  it('räumt nach gelungenem Update auf', () => {
    persisted = {
      ...offer('1.1.0'),
      stagedAppPath: null,
      installAttemptedAt: '2026-10-12T09:00:00Z',
      failedInstalls: 0
    }
    deps = makeDeps({ currentVersion: '1.1.0' })
    mkdirSync(previousBundlePath(deps.bundlePath))
    new AppUpdateService(deps).init()
    expect(persisted).toBeNull()
    expect(existsSync(previousBundlePath(deps.bundlePath))).toBe(false)
  })

  it('setzt einen beim Beenden unterbrochenen Hintergrund-Download fort', async () => {
    persisted = {
      ...offer('1.1.0'),
      stagedAppPath: null,
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
      ...offer('1.1.0'),
      stagedAppPath: staged,
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

  it('meldet eine gescheiterte Installation und bietet sie still erneut an (AK 16, PC 5)', () => {
    deps = makeDeps()
    const staged = join(root, 'app-update', '1.1.0', 'Therascript.app')
    mkdirSync(staged, { recursive: true })
    persisted = {
      ...offer('1.1.0'),
      stagedAppPath: staged,
      installAttemptedAt: '2026-10-12T09:00:00Z',
      failedInstalls: 0
    }
    const service = new AppUpdateService(deps)
    service.init()
    expect(service.getState()).toMatchObject({ phase: 'ready', version: '1.1.0' })
    expect(service.getState().message).toMatch(/automatisch erneut/)
    expect(persisted).toMatchObject({ installAttemptedAt: null, failedInstalls: 1 })
  })
})
