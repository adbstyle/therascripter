import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import type { ManifestApp } from '../../shared/update-manifest'
import type {
  AppUpdateInstallResult,
  AppUpdatePhase,
  AppUpdateState
} from '../../shared/types/AppUpdate'
import type { BusyReason } from './WorkGuard'

/**
 * App-Update in der App (Issues #164, #165, ADR-009).
 *
 * Ablauf: Die geprüfte Update-Beschreibung (UpdateCheckService) meldet eine
 * neuere Version → Download des DMG → sha256 gegen die signierte Beschreibung
 * → DMG einhängen, App daneben kopieren, Version und Signatur der Kopie
 * prüfen → «bereit». Installiert wird beim Beenden der App, nach 10 Minuten
 * ohne Eingabe oder auf Klick — nie während Aufnahme, Verarbeitung oder
 * Modell-Download.
 *
 * Der Austausch selbst sind zwei Umbenennungen im eigenen Prozess, nachdem
 * Warteschlange und Datenbank geordnet geschlossen sind: alte App beiseite,
 * neue an ihren Platz (Spike #157: geht bei laufendem Prozess). Das hält das
 * Beenden kurz (NFR 5). Die alte Version räumt der nächste Start weg — einen
 * Rückweg gibt es nicht (#166 gestrichen).
 *
 * Alle Plattform-Zugriffe laufen über `AppUpdateDeps`, damit der Ablauf ohne
 * Electron testbar ist (Factory in app-update-deps.ts).
 */

/** Ohne Eingabe so lange, dann installiert die App selbständig (AK 7). */
export const IDLE_INSTALL_SECONDS = 10 * 60
/** So viel muss nach einem automatischen Download frei bleiben (AK 12). */
export const MIN_FREE_AFTER_DOWNLOAD = 5 * 1024 ** 3
/** Platz für DMG plus entpackte App (das DMG ist komprimiert, die App ~3.5×). */
const STAGING_FACTOR = 5

export const PersistedAppUpdateSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  /** Geprüfte, installierbare Kopie der neuen App; null solange nicht bereit. */
  stagedAppPath: z.string().nullable(),
  /** Gesetzt unmittelbar vor dem Austausch; der nächste Start wertet ihn aus. */
  installAttemptedAt: z.string().nullable(),
  failedInstalls: z.number().int().nonnegative()
})
export type PersistedAppUpdate = z.infer<typeof PersistedAppUpdateSchema>

export interface QuitInstallPlan {
  relaunch: boolean
  startHidden: boolean
}

export interface AppUpdateDeps {
  currentVersion: string
  bundlePath: string
  /** Arbeitsordner für Download und Kopie — auf demselben Volume wie die App. */
  workDir: string
  /** Grund, warum sich die App nicht selbst ersetzen kann, sonst null. */
  selfReplaceBlocker: () => string | null
  getAutoUpdate: () => boolean
  setAutoUpdate: (enabled: boolean) => void
  readPersisted: () => unknown
  writePersisted: (value: PersistedAppUpdate | null) => void
  setStartHidden: (hidden: boolean) => void
  download: (
    url: string,
    target: string,
    onProgress: (percent: number) => void,
    abortSignal: { aborted: boolean }
  ) => Promise<{ success: boolean; error?: string }>
  sha256OfFile: (path: string) => Promise<string>
  freeBytes: (dir: string) => number | null
  /** Hängt das DMG ein, kopiert die App nach `targetApp`, hängt aus. */
  extractApp: (dmgPath: string, targetApp: string) => Promise<void>
  /** Wirft, wenn Version oder Signatur der Kopie nicht stimmen. */
  verifyApp: (appPath: string, expectedVersion: string) => Promise<void>
  currentWork: () => BusyReason | null
  idleSeconds: () => number
  isWindowVisible: () => boolean
  /** Beendet die App über den normalen Weg (before-quit). */
  quitApp: () => void
  relaunch: () => void
  onStateChange: (state: AppUpdateState) => void
  /**
   * Löscht Ordner (auch App-Bundles). Nicht über Electrons fs: das behandelt
   * app.asar im Bundle als virtuelles Verzeichnis und löscht still nichts.
   */
  removeInBackground: (path: string) => void
  removeNow: (path: string) => void
  log: (message: string) => void
  now: () => Date
}

function isNewer(current: string, candidate: string): boolean {
  const parse = (v: string): number[] => v.split('.').map(Number)
  const [a, b] = [parse(current), parse(candidate)]
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i]
  return false
}

const BUSY_MESSAGE: Record<BusyReason, string> = {
  recording: 'Das Update wird installiert, sobald die Aufnahme beendet ist.',
  processing: 'Das Update wird installiert, sobald die laufende Verarbeitung beendet ist.',
  download: 'Das Update wird installiert, sobald der Modell-Download beendet ist.'
}

export class AppUpdateService {
  private phase: AppUpdatePhase = 'idle'
  private offer: ManifestApp | null = null
  private progress: number | null = null
  private manualDownload = false
  private installPending = false
  private message: string | null = null
  private checkedAt: string | null = null
  private downloadAbort: { aborted: boolean } | null = null
  private quitPlan: QuitInstallPlan | null = null

  constructor(private readonly deps: AppUpdateDeps) {}

  // ── Zustand ──────────────────────────────────────────────────────────────

  getState(): AppUpdateState {
    return {
      phase: this.phase,
      currentVersion: this.deps.currentVersion,
      version: this.offer?.version ?? null,
      sizeBytes: this.offer?.sizeBytes ?? null,
      progress: this.manualDownload ? this.progress : null,
      manualDownload: this.manualDownload,
      autoUpdate: this.deps.getAutoUpdate(),
      installPending: this.installPending,
      message: this.message,
      unsupportedReason: this.phase === 'unsupported' ? this.deps.selfReplaceBlocker() : null,
      checkedAt: this.checkedAt
    }
  }

  private emit(): void {
    this.deps.onStateChange(this.getState())
  }

  private persisted(): PersistedAppUpdate | null {
    const parsed = PersistedAppUpdateSchema.safeParse(this.deps.readPersisted())
    return parsed.success ? parsed.data : null
  }

  private stageDir(version: string): string {
    return join(this.deps.workDir, version)
  }

  /** Arbeitsordner und Merker einer Version verwerfen. */
  private discard(): void {
    this.deps.writePersisted(null)
    this.deps.removeInBackground(this.deps.workDir)
  }

  // ── Start ────────────────────────────────────────────────────────────────

  /**
   * Beim Start: Ergebnis eines Austauschs auswerten, Reste aufräumen und ein
   * bereitliegendes Update wieder anbieten.
   */
  init(): void {
    // Vorversionen vom letzten Austausch (nie während des Beendens gelöscht)
    const parent = dirname(this.deps.bundlePath)
    const previous = basename(previousBundlePath(this.deps.bundlePath))
    for (const name of safeReaddir(parent)) {
      if (name.startsWith(previous)) this.deps.removeInBackground(join(parent, name))
    }

    const saved = this.persisted()
    if (!saved) {
      if (existsSync(this.deps.workDir)) this.deps.removeInBackground(this.deps.workDir)
      return
    }
    if (saved.installAttemptedAt) {
      if (saved.version === this.deps.currentVersion) {
        this.deps.log(`AppUpdate: Update auf ${saved.version} installiert`)
        this.discard()
        return
      }
      // Austausch gescheitert: nur ein Status, still erneut versuchen (AK 16, PC 5)
      this.message = `Die Installation von Version ${saved.version} ist nicht gelungen. Therascript versucht es automatisch erneut.`
      this.deps.writePersisted({
        ...saved,
        installAttemptedAt: null,
        failedInstalls: saved.failedInstalls + 1
      })
    }
    if (!isNewer(this.deps.currentVersion, saved.version)) {
      this.discard()
      return
    }
    this.offer = {
      version: saved.version,
      url: saved.url,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes
    }
    if (saved.stagedAppPath && existsSync(saved.stagedAppPath)) {
      this.phase = 'ready'
    } else {
      this.phase = 'available'
    }
    this.emit()
  }

  // ── Neue Beschreibung ────────────────────────────────────────────────────

  /** Ergebnis einer geprüften Update-Beschreibung (UpdateCheckService). */
  handleManifest(app: ManifestApp | undefined): void {
    this.checkedAt = this.deps.now().toISOString()
    if (!app || !isNewer(this.deps.currentVersion, app.version)) {
      if (this.phase !== 'ready' && this.phase !== 'downloading') this.setIdle()
      this.emit()
      return
    }
    // Eine neuere Version ersetzt ein wartendes oder ladendes Update
    if (
      this.offer &&
      this.offer.version !== app.version &&
      isNewer(this.offer.version, app.version)
    ) {
      this.deps.log(`AppUpdate: ${app.version} ersetzt ${this.offer.version}`)
      this.cancelDownload()
      this.discard()
      this.phase = 'idle'
    }
    if (
      this.offer?.version === app.version &&
      (this.phase === 'ready' || this.phase === 'downloading')
    ) {
      this.emit()
      return
    }

    this.offer = app
    if (this.deps.selfReplaceBlocker()) {
      this.phase = 'unsupported'
      this.emit()
      return
    }
    this.phase = 'available'
    this.emit()
    if (this.deps.getAutoUpdate() && this.hasSpaceFor(app, MIN_FREE_AFTER_DOWNLOAD)) {
      void this.download({ manual: false })
    }
  }

  private setIdle(): void {
    this.phase = 'idle'
    this.offer = null
    this.progress = null
    this.manualDownload = false
  }

  private hasSpaceFor(app: ManifestApp, reserve: number): boolean {
    mkdirSync(this.deps.workDir, { recursive: true })
    const free = this.deps.freeBytes(this.deps.workDir)
    if (free === null) return true
    return free - app.sizeBytes * STAGING_FACTOR >= reserve
  }

  // ── Download und Bereitstellen ───────────────────────────────────────────

  /**
   * Lädt und stellt bereit. Ein automatischer Download bleibt unsichtbar und
   * scheitert still (nächster Versuch bei der nächsten Prüfung); ein selbst
   * gestarteter zeigt Fortschritt und eine Fehlermeldung (AK 3, NFR 3).
   */
  async download({ manual }: { manual: boolean }): Promise<void> {
    const app = this.offer
    if (!app || this.phase === 'downloading' || this.phase === 'ready') return
    if (this.deps.selfReplaceBlocker()) {
      this.phase = 'unsupported'
      this.emit()
      return
    }
    if (manual && !this.hasSpaceFor(app, 0)) {
      const gb = Math.ceil((app.sizeBytes * STAGING_FACTOR) / 1024 ** 3)
      this.message = `Nicht genügend Speicherplatz. Bitte geben Sie mindestens ${gb} GB frei und versuchen Sie es erneut.`
      this.emit()
      return
    }

    const abort = { aborted: false }
    this.downloadAbort = abort
    this.phase = 'downloading'
    this.manualDownload = manual
    this.progress = 0
    this.message = null
    this.emit()

    const dir = this.stageDir(app.version)
    const dmg = join(dir, 'Therascript.dmg')
    const stagedApp = join(dir, 'Therascript.app')
    try {
      mkdirSync(dir, { recursive: true })
      this.deps.writePersisted({
        ...app,
        stagedAppPath: null,
        installAttemptedAt: null,
        failedInstalls: this.persisted()?.failedInstalls ?? 0
      })
      if (!app.url.startsWith('https://'))
        throw new Error('Download-Adresse ist nicht verschlüsselt')
      const result = await this.deps.download(
        app.url,
        dmg,
        (percent) => {
          this.progress = percent
          if (this.manualDownload) this.emit()
        },
        abort
      )
      if (abort.aborted) return
      if (!result.success) throw new Error(result.error ?? 'Download fehlgeschlagen')
      if ((await this.deps.sha256OfFile(dmg)) !== app.sha256) {
        rmSync(dmg, { force: true })
        throw new Error(
          'Die heruntergeladene Datei stimmt nicht mit der signierten Beschreibung überein'
        )
      }
      this.deps.removeNow(stagedApp)
      await this.deps.extractApp(dmg, stagedApp)
      await this.deps.verifyApp(stagedApp, app.version)
      rmSync(dmg, { force: true })
      if (abort.aborted || this.offer?.version !== app.version) return

      this.deps.writePersisted({
        ...app,
        stagedAppPath: stagedApp,
        installAttemptedAt: null,
        failedInstalls: this.persisted()?.failedInstalls ?? 0
      })
      this.phase = 'ready'
      this.progress = null
      this.manualDownload = false
      this.deps.log(`AppUpdate: ${app.version} liegt bereit`)
      this.emit()
    } catch (err) {
      if (abort.aborted) return
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.log(`AppUpdate: Download/Bereitstellen von ${app.version} gescheitert: ${reason}`)
      this.phase = 'available'
      this.progress = null
      if (this.manualDownload) {
        this.message = `Das Update konnte nicht geladen werden (${reason}). Bitte versuchen Sie es später erneut.`
      }
      this.manualDownload = false
      this.emit()
    } finally {
      if (this.downloadAbort === abort) this.downloadAbort = null
    }
  }

  cancelDownload(): void {
    if (!this.downloadAbort) return
    this.downloadAbort.aborted = true
    this.downloadAbort = null
    if (this.phase === 'downloading') {
      this.phase = this.offer ? 'available' : 'idle'
      this.progress = null
      this.manualDownload = false
      this.emit()
    }
  }

  // ── Einstellung (#165) ───────────────────────────────────────────────────

  setAutoUpdate(enabled: boolean): void {
    this.deps.setAutoUpdate(enabled)
    if (!enabled) {
      // Ein Hintergrund-Download stoppt; ein bereitliegendes Update bleibt (PC 2)
      if (this.phase === 'downloading' && !this.manualDownload) this.cancelDownload()
    } else if (
      this.phase === 'available' &&
      this.offer &&
      this.hasSpaceFor(this.offer, MIN_FREE_AFTER_DOWNLOAD)
    ) {
      void this.download({ manual: false })
    }
    this.emit()
  }

  // ── Installieren ─────────────────────────────────────────────────────────

  /** Installation auf Klick (App oder Menüleiste, AK 6). */
  requestInstall(): AppUpdateInstallResult {
    if (this.phase !== 'ready') return { status: 'not-ready' }
    const busy = this.deps.currentWork()
    if (busy) {
      // Vormerken: installiert, sobald nichts mehr läuft (AK 15, PC 9)
      this.installPending = true
      this.message = BUSY_MESSAGE[busy]
      this.emit()
      return { status: 'pending', reason: busy }
    }
    this.installNow()
    return { status: 'installing' }
  }

  private installNow(): void {
    this.installPending = false
    this.quitPlan = { relaunch: true, startHidden: !this.deps.isWindowVisible() }
    this.deps.log('AppUpdate: Installation mit Neustart')
    this.deps.quitApp()
  }

  /**
   * Regelmässig (jede Minute): vorgemerkte Installation nachholen, sobald
   * nichts mehr läuft; bei eingeschalteten automatischen Updates nach
   * 10 Minuten ohne Eingabe selbständig installieren (AK 7). Die Prüfung auf
   * laufende Arbeit erfolgt unmittelbar vor dem Austausch.
   */
  tick(): void {
    if (this.phase !== 'ready' || this.quitPlan) return
    const wantsInstall =
      this.installPending ||
      (this.deps.getAutoUpdate() && this.deps.idleSeconds() >= IDLE_INSTALL_SECONDS)
    if (wantsInstall && this.deps.currentWork() === null) this.installNow()
  }

  /**
   * Zu Beginn von before-quit — vor dem Beenden einer Aufnahme, sonst wäre
   * sie nicht mehr erkennbar. Liefert den Plan für performQuitInstall oder
   * null. Beim Beenden ohne Klick nur mit eingeschalteten automatischen
   * Updates (#165 PC 1) und nur, wenn nichts unterbrochen würde (AK 14).
   */
  prepareQuitInstall(): QuitInstallPlan | null {
    if (this.phase !== 'ready') return null
    if (this.quitPlan) return this.quitPlan
    if (!this.deps.getAutoUpdate() && !this.installPending) return null
    if (this.deps.currentWork() !== null) return null
    return { relaunch: false, startHidden: false }
  }

  /**
   * Der Aufrufer beendet danach mit app.exit(0), nicht app.quit() — ein
   * reguläres Beenden bricht macOS nach dem Umbenennen des eigenen Bundles ab.
   *
   * Nach dem geordneten Herunterfahren (Datenbank geschlossen): Austausch
   * durch zwei Umbenennungen — schnell genug fürs Beenden, auch beim
   * Herunterfahren des Macs (AK 13, NFR 5). Scheitert der Austausch, bleibt
   * die bisherige Version (PC 4); der nächste Start meldet es und versucht
   * es erneut.
   */
  performQuitInstall(plan: QuitInstallPlan): void {
    const saved = this.persisted()
    const staged = saved?.stagedAppPath
    if (saved && staged && existsSync(staged)) {
      this.deps.writePersisted({ ...saved, installAttemptedAt: this.deps.now().toISOString() })
      if (plan.relaunch) this.deps.setStartHidden(plan.startHidden)
      const bundle = this.deps.bundlePath
      const previous = previousBundlePath(bundle)
      try {
        if (existsSync(previous)) renameSync(previous, `${previous}-${this.deps.now().getTime()}`)
        renameSync(bundle, previous)
        try {
          renameSync(staged, bundle)
        } catch (err) {
          renameSync(previous, bundle)
          throw err
        }
      } catch (err) {
        this.deps.log(
          `AppUpdate: Austausch gescheitert: ${err instanceof Error ? err.message : err}`
        )
      }
    }
    // Auch nach einem gescheiterten Austausch neu starten — die Nutzer:in hat
    // «Installieren» gewählt und erwartet eine laufende App.
    if (plan.relaunch) this.deps.relaunch()
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Ablage der Vorversion während des Austauschs — versteckt neben der App. */
export function previousBundlePath(bundlePath: string): string {
  return join(dirname(bundlePath), '.Therascript-previous.app')
}
