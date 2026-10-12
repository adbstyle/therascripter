import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import type { ManifestApp } from '../../shared/update-manifest'
import { isNewerVersion } from '../../shared/version'
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
/** Namenszusatz für beiseite geschobene, im Hintergrund gelöschte Ordner. */
const TRASH_MARK = '.deleting-'

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
    abortSignal: AbortSignal
  ) => Promise<{ success: boolean; error?: string }>
  sha256OfFile: (path: string) => Promise<string>
  freeBytes: (dir: string) => number | null
  /** Hängt das DMG ein, kopiert die App nach `targetApp`, hängt aus. */
  extractApp: (dmgPath: string, targetApp: string, signal: AbortSignal) => Promise<void>
  /** Wirft, wenn Version oder Signatur der Kopie nicht stimmen. */
  verifyApp: (appPath: string, expectedVersion: string, signal: AbortSignal) => Promise<void>
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
  removeNow: (path: string) => Promise<void>
  log: (message: string) => void
  now: () => Date
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
  private checkFailed = false
  private downloadAbort: AbortController | null = null
  /** Letzter Download-Lauf — der nächste wartet, bis er fertig aufgeräumt hat. */
  private lastRun: Promise<void> = Promise.resolve()
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
      checkedAt: this.checkedAt,
      checkFailed: this.checkFailed
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
    this.removeAside(this.deps.workDir)
  }

  /**
   * Löscht im Hintergrund, schiebt den Ordner aber vorher atomar beiseite:
   * Ein gleich danach startender Download legt seinen Ordner sonst dort an,
   * wo rm noch leert. Liegengebliebenes räumt init() beim nächsten Start weg.
   */
  private removeAside(path: string): void {
    if (!existsSync(path)) return
    let target = path
    if (!basename(path).includes(TRASH_MARK)) {
      try {
        target = `${path}${TRASH_MARK}${this.deps.now().getTime()}`
        renameSync(path, target)
      } catch {
        target = path
      }
    }
    this.deps.removeInBackground(target)
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
      if (name.startsWith(previous)) this.removeAside(join(parent, name))
    }
    // Beim letzten Beenden nicht fertig gelöschte Arbeitsordner
    const workParent = dirname(this.deps.workDir)
    const trashPrefix = `${basename(this.deps.workDir)}${TRASH_MARK}`
    for (const name of safeReaddir(workParent)) {
      if (name.startsWith(trashPrefix)) this.removeAside(join(workParent, name))
    }

    const saved = this.persisted()
    if (!saved) {
      this.removeAside(this.deps.workDir)
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
    if (!isNewerVersion(this.deps.currentVersion, saved.version)) {
      this.discard()
      return
    }
    this.offer = {
      version: saved.version,
      url: saved.url,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes
    }
    if (this.deps.selfReplaceBlocker()) {
      // Z. B. jetzt aus dem DMG gestartet: kein Austausch, der bei jedem
      // Beenden scheitern würde, sondern der Weg über die Anleitung (AK 9)
      this.phase = 'unsupported'
    } else if (saved.stagedAppPath && existsSync(saved.stagedAppPath)) {
      this.phase = 'ready'
    } else {
      this.phase = 'available'
      // Ein beim Beenden unterbrochener Hintergrund-Download läuft gleich weiter
      if (this.deps.getAutoUpdate() && this.startAutoDownload(this.offer)) return
    }
    this.emit()
  }

  // ── Neue Beschreibung ────────────────────────────────────────────────────

  /** Ergebnis einer geprüften Update-Beschreibung (UpdateCheckService). */
  handleManifest(app: ManifestApp | undefined): void {
    this.checkedAt = this.deps.now().toISOString()
    this.checkFailed = false
    if (!app || !isNewerVersion(this.deps.currentVersion, app.version)) {
      if (this.phase !== 'ready' && this.phase !== 'downloading') this.setIdle()
      this.emit()
      return
    }
    // Eine neuere Version ersetzt ein wartendes oder ladendes Update
    if (this.offer && isNewerVersion(this.offer.version, app.version)) {
      this.deps.log(`AppUpdate: ${app.version} ersetzt ${this.offer.version}`)
      this.downloadAbort?.abort()
      this.downloadAbort = null
      this.discard()
      this.phase = 'idle'
      this.message = null
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
    if (this.deps.getAutoUpdate() && this.startAutoDownload(app)) return
    this.emit()
  }

  /** Eine Prüfung ist gescheitert (UpdateCheckService) — kein «aktuell» anzeigen. */
  handleCheckFailed(): void {
    this.checkFailed = true
    this.emit()
  }

  /**
   * Startet den Hintergrund-Download, wenn danach genug Platz bleibt (AK 12).
   * Sonst ein Hinweis — ohne ihn bliebe das Update bei eingeschalteten
   * automatischen Updates unbemerkt liegen. true = Download läuft (und meldet
   * seinen Zustand selbst).
   */
  private startAutoDownload(app: ManifestApp): boolean {
    if (!this.hasSpaceFor(app, MIN_FREE_AFTER_DOWNLOAD)) {
      const gb = Math.ceil((app.sizeBytes * STAGING_FACTOR + MIN_FREE_AFTER_DOWNLOAD) / 1024 ** 3)
      this.message = `Für das automatische Update auf Version ${app.version} fehlt Speicherplatz (mindestens ${gb} GB frei). Sie können es hier selbst herunterladen oder Platz freigeben.`
      return false
    }
    void this.download({ manual: false })
    return true
  }

  private setIdle(): void {
    this.phase = 'idle'
    this.offer = null
    this.progress = null
    this.manualDownload = false
    this.message = null
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
   * scheitert ohne Meldung — das Update steht dann als verfügbar da, der
   * nächste Versuch folgt bei der nächsten Prüfung; ein selbst gestarteter
   * zeigt Fortschritt und eine Fehlermeldung (AK 3, NFR 3).
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

    const abort = new AbortController()
    this.downloadAbort = abort
    this.phase = 'downloading'
    this.manualDownload = manual
    this.progress = 0
    this.message = null
    this.emit()

    // Ein abgebrochener Lauf hängt erst aus und stoppt seine Kopie, bevor der
    // nächste in denselben Ordner schreibt
    const run = this.lastRun.then(() => this.stage(app, abort))
    this.lastRun = run
    await run
  }

  /** Download, Prüfung und Bereitstellen eines Laufs. Wirft nie. */
  private async stage(app: ManifestApp, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) return
    const dir = this.stageDir(app.version)
    const dmg = join(dir, 'Therascript.dmg')
    const stagedApp = join(dir, 'Therascript.app')
    try {
      // Reste anderer Versionen, z. B. eines ersetzten Updates
      for (const name of safeReaddir(this.deps.workDir)) {
        if (name !== app.version) this.removeAside(join(this.deps.workDir, name))
      }
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
          if (abort.signal.aborted) return
          this.progress = percent
          if (this.manualDownload) this.emit()
        },
        abort.signal
      )
      if (abort.signal.aborted) return
      if (!result.success) throw new Error(result.error ?? 'Download fehlgeschlagen')
      if ((await this.deps.sha256OfFile(dmg)) !== app.sha256) {
        rmSync(dmg, { force: true })
        throw new Error(
          'Die heruntergeladene Datei stimmt nicht mit der signierten Beschreibung überein'
        )
      }
      await this.deps.removeNow(stagedApp)
      await this.deps.extractApp(dmg, stagedApp, abort.signal)
      await this.deps.verifyApp(stagedApp, app.version, abort.signal)
      rmSync(dmg, { force: true })
      if (abort.signal.aborted || this.offer?.version !== app.version) return

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
      if (abort.signal.aborted) return
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
    this.downloadAbort.abort()
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
      // Ein Platz-Hinweis zum automatischen Update gilt nicht mehr
      if (this.phase === 'available') this.message = null
    } else if (this.phase === 'available' && this.offer && this.startAutoDownload(this.offer)) {
      return
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
