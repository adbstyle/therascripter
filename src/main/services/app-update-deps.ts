import { app, BrowserWindow, powerMonitor } from 'electron'
import { execFileSync, spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  rmSync,
  statSync,
  statfsSync
} from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { getSettings } from './SettingsService'
import { downloadFile } from './DownloadService'
import { currentWork } from './WorkGuard'
import { runSubprocess } from '../utils/subprocess'
import { sendToRenderer } from '../utils/ipc-helpers'
import { AppUpdateService, type AppUpdateDeps } from './AppUpdateService'
import type { AppUpdateState } from '../../shared/types/AppUpdate'

const BUNDLE_ID = 'com.therascript.app'

/** Pfad des laufenden App-Bundles (…/Therascript.app). */
export function runningBundlePath(): string {
  return resolve(app.getPath('exe'), '..', '..', '..')
}

/**
 * Kann sich die App selbst ersetzen? Nur aus dem Ordner «Programme», mit
 * Schreibrecht und als Eigentümer:in (ADR-009, Epic Out of Scope 6). Sonst
 * ein Satz für die Nutzer:in, warum es nicht geht.
 */
export function selfReplaceBlocker(bundle = runningBundlePath()): string | null {
  if (!app.isPackaged) return 'Die Entwicklungsversion aktualisiert sich nicht selbst.'
  const parent = dirname(bundle)
  const inApplications = parent === '/Applications' || parent === join(homedir(), 'Applications')
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/') || !inApplications) {
    return 'Therascript läuft nicht aus dem Ordner «Programme» und kann sich deshalb nicht selbst aktualisieren.'
  }
  try {
    accessSync(parent, constants.W_OK)
    accessSync(bundle, constants.W_OK)
    if (statSync(bundle).uid !== process.getuid?.()) throw new Error('fremder Eigentümer')
  } catch {
    return 'Therascript darf sich in diesem Benutzerkonto nicht selbst ersetzen (fehlende Schreibrechte für den Ordner «Programme»).'
  }
  return null
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject)
  })
}

async function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  const result = await runSubprocess({ bin, args, timeoutMs })
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').pop() ?? ''
    throw new Error(
      `${bin.split('/').pop()} fehlgeschlagen (${result.code ?? 'Signal'}): ${detail}`
    )
  }
  return result.stdout
}

/** Hängt das DMG an einem privaten Ort ein, kopiert die App, hängt immer aus. */
async function extractApp(dmgPath: string, targetApp: string): Promise<void> {
  const mountPoint = join(dirname(targetApp), 'mnt')
  rmSync(mountPoint, { recursive: true, force: true })
  await run(
    '/usr/bin/hdiutil',
    [
      'attach',
      dmgPath,
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      '-noverify',
      '-mountpoint',
      mountPoint
    ],
    120_000
  )
  try {
    // --noqtn: keine Quarantäne-Attribute mitkopieren (ADR-009 Befund 3)
    await run(
      '/usr/bin/ditto',
      ['--noqtn', join(mountPoint, 'Therascript.app'), targetApp],
      600_000
    )
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], 60_000).catch(() => undefined)
  }
}

/**
 * Prüft die Kopie vor dem Bereitstellen: richtige Version, intakte Signatur
 * und die Designated Requirement, an der Mikrofon-Berechtigung und
 * Schlüsselbund hängen (#161) — sonst verlöre ein Update beides.
 */
async function verifyApp(appPath: string, expectedVersion: string): Promise<void> {
  const version = (
    await run(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')],
      10_000
    )
  ).trim()
  if (version !== expectedVersion) {
    throw new Error(`Paket enthält Version ${version} statt ${expectedVersion}`)
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], 300_000)
  const requirement = await runSubprocess({
    bin: '/usr/bin/codesign',
    args: ['-d', '-r-', appPath],
    timeoutMs: 30_000
  })
  const text = `${requirement.stdout}\n${requirement.stderr}`
  if (!text.includes(`designated => identifier "${BUNDLE_ID}"`)) {
    throw new Error('Signatur der neuen Version ohne stabile Designated Requirement')
  }
}

async function download(
  url: string,
  target: string,
  onProgress: (percent: number) => void,
  abortSignal: { aborted: boolean }
): Promise<{ success: boolean; error?: string }> {
  const result = await downloadFile(url, target, (p) => onProgress(p.percent), abortSignal)
  // Ein vollständiges .partial beantwortet der Server mit 416 — neu laden
  if (!result.success && result.error?.includes('416')) {
    rmSync(`${target}.partial`, { force: true })
    return downloadFile(url, target, (p) => onProgress(p.percent), abortSignal)
  }
  return result
}

export function createAppUpdateDeps(onState: (state: AppUpdateState) => void): AppUpdateDeps {
  const settings = getSettings()
  return {
    currentVersion: app.getVersion(),
    bundlePath: runningBundlePath(),
    workDir: join(app.getPath('userData'), 'app-update'),
    selfReplaceBlocker: () => selfReplaceBlocker(),
    getAutoUpdate: () => settings.get('autoUpdate') !== false,
    setAutoUpdate: (enabled) => settings.set('autoUpdate', enabled),
    readPersisted: () => settings.get('appUpdate'),
    writePersisted: (value) => settings.set('appUpdate', value),
    setStartHidden: (hidden) => settings.set('startHiddenAfterUpdate', hidden),
    download,
    sha256OfFile,
    freeBytes: (dir) => {
      try {
        const stats = statfsSync(dir)
        return stats.bavail * stats.bsize
      } catch {
        return null
      }
    },
    extractApp,
    verifyApp,
    currentWork,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    isWindowVisible: () => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
    quitApp: () => app.quit(),
    relaunch: () => app.relaunch(),
    onStateChange: (state) => {
      sendToRenderer('appUpdate:state', state)
      onState(state)
    },
    removeInBackground: (path) => {
      if (!existsSync(path)) return
      spawn('/bin/rm', ['-rf', path], { detached: true, stdio: 'ignore' }).unref()
    },
    removeNow: (path) => {
      if (existsSync(path)) execFileSync('/bin/rm', ['-rf', path])
    },
    log: (message) => console.log(message),
    now: () => new Date()
  }
}

let service: AppUpdateService | null = null

/** Einmal beim Start (nach initSettings), danach getAppUpdateService(). */
export function initAppUpdateService(onState: (state: AppUpdateState) => void): AppUpdateService {
  service = new AppUpdateService(createAppUpdateDeps(onState))
  service.init()
  return service
}

export function getAppUpdateService(): AppUpdateService | null {
  return service
}
