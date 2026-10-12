import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import type { ManifestApp } from '../../shared/update-manifest'
import { isNewerVersion } from '../../shared/version'
import {
  BundleModelSchema,
  type BundleModel,
  type ManifestModelInput
} from '../../shared/validation/model-update-schemas'
import {
  bundleBytes,
  bundleKey,
  modelStagingBytes,
  selectBundle,
  type LocalLayout,
  type UpdateBundle
} from '../../shared/update-bundle'
import type {
  AppUpdateInstallResult,
  AppUpdatePhase,
  AppUpdateState
} from '../../shared/types/AppUpdate'
import {
  BACKUP_DIR_NAME,
  hasLeftoverBackup,
  isModelStaged,
  modelStageRoot,
  modelsSwappedIn,
  rollbackModels,
  swapModelsIn
} from './model-staging'
import type { BusyReason } from './WorkGuard'

/**
 * Updates in der App (Issues #164, #165, #167, ADR-009). App und Modelle sind
 * ein Vorgang mit einem einzigen Neustart.
 *
 * Ablauf: Die geprüfte Update-Beschreibung (UpdateCheckService) ergibt ein
 * Update (update-bundle.ts): eine neuere App, neue Fassungen der
 * installierten Modelle und Pflichtmodelle der neuen Version. Alle Teile
 * werden nacheinander geladen und gegen die signierte Beschreibung geprüft —
 * die App als DMG (einhängen, kopieren, Version und Signatur prüfen), die
 * Modelle nach models/.update/ (model-staging.ts) — → «bereit». Installiert
 * wird beim Beenden der App, nach 10 Minuten ohne Eingabe oder auf Klick —
 * nie während Aufnahme, Verarbeitung oder Modell-Download.
 *
 * Der Austausch sind nur Umbenennungen im eigenen Prozess, nachdem
 * Warteschlange und Datenbank geordnet geschlossen sind: zuerst die Modelle,
 * zuletzt die App (Spike #157: geht bei laufendem Prozess). Scheitert ein
 * Teil, wird alles zurückgetauscht — alles oder nichts. Der nächste Start
 * prüft anhand der Festplatte, ob alles getauscht ist, und trägt erst dann
 * die neuen Modell-Fassungen ein. Alte Fassungen räumt er weg — einen
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
/** Nach so vielen gescheiterten Installationen nur noch auf Klick (keine Neustart-Schleife). */
export const MAX_SILENT_INSTALL_ATTEMPTS = 3

const semver = z.string().regex(/^\d+\.\d+\.\d+$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

const PersistedAppPartSchema = z.object({
  version: semver,
  url: z.string().url(),
  sha256,
  sizeBytes: z.number().int().positive(),
  /** Geprüfte, installierbare Kopie der neuen App; null solange nicht bereit. */
  stagedAppPath: z.string().nullable()
})

/** Gespeichertes Update (Einstellung appUpdate) — übersteht Neustarts. */
export const PersistedUpdateSchema = z.object({
  schema: z.literal(2),
  app: PersistedAppPartSchema.nullable(),
  models: z.array(BundleModelSchema),
  /** Gesetzt unmittelbar vor dem Austausch; der nächste Start wertet ihn aus. */
  installAttemptedAt: z.string().nullable(),
  failedInstalls: z.number().int().nonnegative()
})
export type PersistedUpdate = z.infer<typeof PersistedUpdateSchema>

/** Bis #164 (v0.9.x): nur die App. */
const LegacyPersistedSchema = PersistedAppPartSchema.extend({
  installAttemptedAt: z.string().nullable(),
  failedInstalls: z.number().int().nonnegative()
})

/**
 * Liest das gespeicherte Update, auch im Format vor #167. Eine App-Kopie
 * ausserhalb des Arbeitsordners wird verworfen — sie würde beim Austausch
 * die App ersetzen.
 */
export function readPersistedUpdate(raw: unknown, workDir: string): PersistedUpdate | null {
  let record: PersistedUpdate
  const current = PersistedUpdateSchema.safeParse(raw)
  if (current.success) {
    record = current.data
  } else {
    const legacy = LegacyPersistedSchema.safeParse(raw)
    if (!legacy.success) return null
    const { installAttemptedAt, failedInstalls, ...app } = legacy.data
    record = { schema: 2, app, models: [], installAttemptedAt, failedInstalls }
  }
  const staged = record.app?.stagedAppPath
  if (staged && !staged.startsWith(`${workDir}/`)) return null
  return record
}

export interface QuitInstallPlan {
  relaunch: boolean
  startHidden: boolean
}

/** Woraus ein Update berechnet wird: eine geprüfte Beschreibung bzw. das gespeicherte Update. */
export interface UpdateSource {
  app?: ManifestApp
  models: readonly ManifestModelInput[]
}

export interface AppUpdateDeps {
  currentVersion: string
  /** false in der Entwicklungsversion: dort tauscht nichts aus (Neustart beendete den Dev-Server). */
  isPackaged: boolean
  bundlePath: string
  /** Arbeitsordner für Download und Kopie der App — auf demselben Volume wie die App. */
  workDir: string
  /** ~/.therascript/models — Modelle werden in models/.update/ bereitgestellt. */
  modelsDir: string
  /** Grund, warum sich die App nicht selbst ersetzen kann, sonst null. */
  selfReplaceBlocker: () => string | null
  /** Ersteinrichtung abgeschlossen? Vorher wird nichts bereitgestellt. */
  setupComplete: () => boolean
  /** Ablage der Modelle im Katalog dieser App. */
  localLayouts: () => LocalLayout[]
  retiredIds: () => ReadonlySet<string>
  /** Installierte Fassung eines Modells ('' = unbekannt, null = kein Eintrag). */
  installedSha: (id: string) => string | null
  /** Neue Fassung eintragen — erst, wenn der Austausch nachweislich gelungen ist. */
  recordInstalledModel: (model: BundleModel) => void
  getAutoUpdate: () => boolean
  setAutoUpdate: (enabled: boolean) => void
  readPersisted: () => unknown
  writePersisted: (value: PersistedUpdate | null) => void
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
  /** Lädt, prüft und entpackt ein Modell nach models/.update/ (model-staging.ts). */
  stageModel: (
    model: BundleModel,
    onProgress: (percent: number) => void,
    signal: AbortSignal
  ) => Promise<void>
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

/** «von Version 1.2.0» bzw. «des Modell-Updates» — für Meldungen. */
function ofUpdate(bundle: { app: { version: string } | null }): string {
  return bundle.app ? `von Version ${bundle.app.version}` : 'des Modell-Updates'
}

function describe(bundle: UpdateBundle): string {
  const models = bundle.models.map((m) => m.id).join(', ')
  return [bundle.app && `App ${bundle.app.version}`, models && `Modelle ${models}`]
    .filter(Boolean)
    .join(' + ')
}

function sourceOf(record: PersistedUpdate): UpdateSource {
  const app = record.app
  return {
    ...(app
      ? {
          app: { version: app.version, url: app.url, sha256: app.sha256, sizeBytes: app.sizeBytes }
        }
      : {}),
    models: record.models
  }
}

export class AppUpdateService {
  private phase: AppUpdatePhase = 'idle'
  private bundle: UpdateBundle | null = null
  /** Neuere App, die sich nicht selbst ersetzen kann — Weg über die Anleitung. */
  private manualApp: ManifestApp | null = null
  /** Letzte geprüfte Beschreibung — Grundlage, wenn sich Modelle ändern. */
  private lastSource: UpdateSource | null = null
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
  /** > 0, solange unter Einstellungen → Modelle ein Modell geladen wird. */
  private stagingPaused = 0

  constructor(private readonly deps: AppUpdateDeps) {}

  // ── Zustand ──────────────────────────────────────────────────────────────

  getState(): AppUpdateState {
    const bundle = this.bundle
    return {
      phase: this.phase,
      currentVersion: this.deps.currentVersion,
      version: bundle ? (bundle.app?.version ?? null) : (this.manualApp?.version ?? null),
      sizeBytes: bundle ? bundleBytes(bundle) : (this.manualApp?.sizeBytes ?? null),
      appSizeBytes: bundle?.app?.sizeBytes ?? null,
      models:
        bundle?.models.map((m) => ({
          id: m.id,
          label: m.label,
          sizeBytes: m.sizeBytes,
          kind: m.kind
        })) ?? [],
      diskNeedBytes: bundle && this.phase === 'available' ? this.stagingNeed(bundle) : null,
      progress: this.manualDownload ? this.progress : null,
      manualDownload: this.manualDownload,
      autoUpdate: this.deps.getAutoUpdate(),
      installPending: this.installPending,
      message: this.message,
      unsupportedReason: this.manualApp ? this.deps.selfReplaceBlocker() : null,
      manualVersion: this.manualApp?.version ?? null,
      checkedAt: this.checkedAt,
      checkFailed: this.checkFailed
    }
  }

  private emit(): void {
    this.deps.onStateChange(this.getState())
  }

  private persisted(): PersistedUpdate | null {
    return readPersistedUpdate(this.deps.readPersisted(), this.deps.workDir)
  }

  /** Update verwerfen: Merker und alle bereitgestellten Teile. */
  private discard(): void {
    this.deps.writePersisted(null)
    this.clearStaging(null)
  }

  /** Bereitgestellte Teile entfernen, die nicht zu `keep` gehören. */
  private clearStaging(keep: UpdateBundle | null): void {
    for (const name of safeReaddir(this.deps.workDir)) {
      if (name.includes(TRASH_MARK) || name === keep?.app?.version) continue
      this.removeAside(join(this.deps.workDir, name))
    }
    const root = modelStageRoot(this.deps.modelsDir)
    const keepShas = new Set(keep?.models.map((m) => m.sha256) ?? [])
    for (const name of safeReaddir(root)) {
      // Sicherungen nie hier: sie können die einzige Fassung eines Modells sein
      if (name.includes(TRASH_MARK) || name === BACKUP_DIR_NAME || keepShas.has(name)) continue
      this.removeAside(join(root, name))
    }
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

  private appStaged(app: ManifestApp, record = this.persisted()): boolean {
    const part = record?.app
    return (
      !!part?.stagedAppPath &&
      part.version === app.version &&
      part.sha256 === app.sha256 &&
      existsSync(part.stagedAppPath)
    )
  }

  private isFullyStaged(bundle: UpdateBundle): boolean {
    return (
      (!bundle.app || this.appStaged(bundle.app)) &&
      bundle.models.every((m) => isModelStaged(this.deps.modelsDir, m))
    )
  }

  /** Freier Speicher, den die noch nicht bereitgestellten Teile brauchen (NFR 1). */
  private stagingNeed(bundle: UpdateBundle): number {
    let need = bundle.app && !this.appStaged(bundle.app) ? bundle.app.sizeBytes * STAGING_FACTOR : 0
    for (const model of bundle.models) {
      if (!isModelStaged(this.deps.modelsDir, model)) need += modelStagingBytes(model)
    }
    return need
  }

  private hasFree(bytes: number): boolean {
    mkdirSync(this.deps.workDir, { recursive: true })
    const free = [
      this.deps.freeBytes(this.deps.workDir),
      this.deps.freeBytes(this.deps.modelsDir)
    ].filter((b): b is number => b !== null)
    return free.length === 0 || Math.min(...free) >= bytes
  }

  /** Update-Merker neu schreiben; Bereitgestelltes und Fehlversuche desselben Updates bleiben. */
  private writeRecord(bundle: UpdateBundle): void {
    const previous = this.persisted()
    const sameUpdate =
      previous !== null &&
      bundleKey({ app: previous.app, models: previous.models }) === bundleKey(bundle)
    this.deps.writePersisted({
      schema: 2,
      app: bundle.app
        ? {
            ...bundle.app,
            stagedAppPath:
              bundle.app && this.appStaged(bundle.app, previous)
                ? (previous?.app?.stagedAppPath ?? null)
                : null
          }
        : null,
      models: bundle.models,
      installAttemptedAt: null,
      failedInstalls: sameUpdate ? previous.failedInstalls : 0
    })
  }

  // ── Update berechnen ─────────────────────────────────────────────────────

  private select(source: UpdateSource): {
    bundle: UpdateBundle | null
    manualApp: ManifestApp | null
  } {
    // Vor der Ersteinrichtung lädt der Ersteinrichtungs-Bildschirm — nichts daneben
    if (!this.deps.setupComplete()) return { bundle: null, manualApp: null }
    const newerApp =
      source.app && isNewerVersion(this.deps.currentVersion, source.app.version) ? source.app : null
    const blocker = this.deps.selfReplaceBlocker()
    if (!this.deps.isPackaged) return { bundle: null, manualApp: newerApp }
    const bundle = selectBundle(source, {
      currentVersion: this.deps.currentVersion,
      appInstallable: blocker === null,
      localLayouts: this.deps.localLayouts(),
      retiredIds: this.deps.retiredIds(),
      installedSha: this.deps.installedSha,
      isOnDisk: (checkPath) => existsSync(join(this.deps.modelsDir, checkPath))
    })
    return { bundle, manualApp: blocker && newerApp ? newerApp : null }
  }

  /** Ein neu berechnetes Update übernehmen. */
  private apply(
    selection: { bundle: UpdateBundle | null; manualApp: ManifestApp | null },
    { keepReady }: { keepReady: boolean }
  ): void {
    // Während des Beendens eingefroren — sonst räumte eine späte Prüfung weg,
    // was gerade installiert wird
    if (this.quitPlan) return
    this.manualApp = selection.manualApp
    let next = selection.bundle
    if (!next && keepReady && this.bundle && this.phase !== 'available') {
      // Eine Beschreibung ohne dieses Update nimmt ein ladendes oder
      // bereitliegendes nicht zurück, solange es zu diesem Mac passt
      next = this.select(sourceOf(this.recordOf(this.bundle))).bundle
    }

    if (!next) {
      this.abortRun()
      if (this.bundle || this.persisted()) this.discard()
      this.setIdle()
      if (this.manualApp) this.phase = 'unsupported'
      this.emit()
      return
    }

    if (!this.bundle || bundleKey(this.bundle) !== bundleKey(next)) {
      if (this.bundle)
        this.deps.log(`AppUpdate: ${describe(next)} ersetzt ${describe(this.bundle)}`)
      this.abortRun()
      this.installPending = false
      this.message = null
      this.bundle = next
      this.writeRecord(next)
      this.clearStaging(next)
    } else if (this.phase === 'downloading' || this.phase === 'ready') {
      this.emit()
      return
    }

    if (this.isFullyStaged(next)) {
      this.phase = 'ready'
      this.emit()
      return
    }
    this.phase = 'available'
    if (this.deps.getAutoUpdate() && this.startAutoDownload(next)) return
    this.emit()
  }

  private recordOf(bundle: UpdateBundle): PersistedUpdate {
    return {
      schema: 2,
      app: bundle.app ? { ...bundle.app, stagedAppPath: null } : null,
      models: bundle.models,
      installAttemptedAt: null,
      failedInstalls: 0
    }
  }

  private abortRun(): void {
    this.downloadAbort?.abort()
    this.downloadAbort = null
  }

  private setIdle(): void {
    this.phase = 'idle'
    this.bundle = null
    this.progress = null
    this.manualDownload = false
    this.installPending = false
    this.message = null
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
    // Beim letzten Beenden nicht fertig gelöschte Ordner
    const workParent = dirname(this.deps.workDir)
    const trashPrefix = `${basename(this.deps.workDir)}${TRASH_MARK}`
    for (const name of safeReaddir(workParent)) {
      if (name.startsWith(trashPrefix)) this.removeAside(join(workParent, name))
    }
    for (const dir of [this.deps.workDir, modelStageRoot(this.deps.modelsDir)]) {
      for (const name of safeReaddir(dir)) {
        if (name.includes(TRASH_MARK)) this.removeAside(join(dir, name))
      }
    }

    let record = this.persisted()
    if (!record) {
      this.clearStaging(null)
      return
    }

    let failure: string | null = null
    if (record.installAttemptedAt) {
      // Die Festplatte entscheidet, nicht der Merker: alles getauscht?
      const appDone = !record.app || !isNewerVersion(this.deps.currentVersion, record.app.version)
      if (appDone && modelsSwappedIn(this.deps.modelsDir, record.models)) {
        for (const model of record.models) this.deps.recordInstalledModel(model)
        this.deps.log(`AppUpdate: Update ${ofUpdate(record)} installiert`)
        this.discard()
        // Die bisherigen Modell-Fassungen werden jetzt nicht mehr gebraucht
        this.removeAside(join(modelStageRoot(this.deps.modelsDir), BACKUP_DIR_NAME))
        return
      }
      // Austausch gescheitert oder abgebrochen: alles zurück, still erneut versuchen (AK 16, PC 5)
      rollbackModels(this.deps.modelsDir, record.models)
      record = { ...record, installAttemptedAt: null, failedInstalls: record.failedInstalls + 1 }
      this.deps.writePersisted(record)
      failure =
        record.failedInstalls >= MAX_SILENT_INSTALL_ATTEMPTS
          ? `Die Installation ${ofUpdate(record)} ist mehrmals nicht gelungen. Bitte starten Sie sie hier selbst.`
          : `Die Installation ${ofUpdate(record)} ist nicht gelungen. Therascript versucht es automatisch erneut.`
    }

    // Gespeichertes Update gegen den heutigen Stand prüfen: was inzwischen
    // überholt ist (App von Hand aktualisiert, Modell gelöscht), fällt weg
    this.apply(this.select(sourceOf(record)), { keepReady: false })
    if (failure && this.bundle) {
      this.message = failure
      this.emit()
    }
  }

  // ── Neue Beschreibung ────────────────────────────────────────────────────

  /** Ergebnis einer geprüften Update-Beschreibung (UpdateCheckService). */
  handleManifest(source: UpdateSource): void {
    this.checkedAt = this.deps.now().toISOString()
    this.checkFailed = false
    this.lastSource = source
    this.apply(this.select(source), { keepReady: true })
  }

  /** Eine Prüfung ist gescheitert (UpdateCheckService) — kein «aktuell» anzeigen. */
  handleCheckFailed(): void {
    this.checkFailed = true
    this.emit()
  }

  /**
   * Modelle wurden geladen oder gelöscht (Einstellungen → Modelle,
   * Ersteinrichtung): Update neu berechnen. Ein Modell, das schon aktuell
   * oder nicht mehr installiert ist, fällt weg; sein Bereitgestelltes auch.
   */
  handleModelsChanged(): void {
    const record = this.persisted()
    const source = this.lastSource ?? (record ? sourceOf(record) : null)
    if (!source) return
    this.apply(this.select(source), { keepReady: false })
  }

  /**
   * Ein Modell-Download in den Einstellungen hat Vorrang: das Bereitstellen
   * pausiert (strikt ein Download nach dem anderen) und läuft danach weiter.
   */
  async withStagingPaused<T>(work: () => Promise<T>): Promise<T> {
    this.stagingPaused++
    if (this.phase === 'downloading') this.cancelDownload()
    await this.lastRun
    try {
      return await work()
    } finally {
      this.stagingPaused--
      if (this.stagingPaused === 0) this.handleModelsChanged()
    }
  }

  /**
   * Startet den Hintergrund-Download, wenn danach genug Platz bleibt (AK 8).
   * Sonst ein Hinweis — ohne ihn bliebe das Update bei eingeschalteten
   * automatischen Updates unbemerkt liegen. true = Download läuft (und meldet
   * seinen Zustand selbst).
   */
  private startAutoDownload(bundle: UpdateBundle): boolean {
    if (this.stagingPaused > 0) return false
    const need = this.stagingNeed(bundle)
    if (!this.hasFree(need + MIN_FREE_AFTER_DOWNLOAD)) {
      const gb = Math.ceil((need + MIN_FREE_AFTER_DOWNLOAD) / 1024 ** 3)
      const what = bundle.app ? `auf Version ${bundle.app.version}` : 'der Modelle'
      this.message = `Für das automatische Update ${what} fehlt Speicherplatz (mindestens ${gb} GB frei). Sie können es hier selbst herunterladen oder Platz freigeben.`
      return false
    }
    void this.download({ manual: false })
    return true
  }

  // ── Download und Bereitstellen ───────────────────────────────────────────

  /**
   * Lädt und stellt alle Teile bereit. Ein automatischer Download bleibt
   * unsichtbar und scheitert ohne Meldung — das Update steht dann als
   * verfügbar da, der nächste Versuch folgt bei der nächsten Prüfung; ein
   * selbst gestarteter zeigt Fortschritt und eine Fehlermeldung (AK 3, NFR 3).
   */
  async download({ manual }: { manual: boolean }): Promise<void> {
    const bundle = this.bundle
    if (!bundle || this.phase === 'downloading' || this.phase === 'ready') return
    if (this.stagingPaused > 0) {
      if (manual) {
        this.message =
          'Unter Einstellungen → Modelle wird gerade ein Modell geladen. Bitte starten Sie das Update danach.'
        this.emit()
      }
      return
    }
    if (manual) {
      const need = this.stagingNeed(bundle)
      if (!this.hasFree(need)) {
        const gb = Math.ceil(need / 1024 ** 3)
        this.message = `Nicht genügend Speicherplatz. Bitte geben Sie mindestens ${gb} GB frei und versuchen Sie es erneut.`
        this.emit()
        return
      }
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
    const run = this.lastRun.then(() => this.stageBundle(bundle, abort))
    this.lastRun = run
    await run
  }

  /** Alle Teile nacheinander: zuerst die App, dann die Modelle. Wirft nie. */
  private async stageBundle(bundle: UpdateBundle, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) return
    const key = bundleKey(bundle)
    const total = bundleBytes(bundle)
    let done = 0
    const reporter =
      (partBytes: number) =>
      (percent: number): void => {
        if (abort.signal.aborted) return
        this.progress = Math.min(
          100,
          Math.round(((done + (partBytes * percent) / 100) / total) * 100)
        )
        if (this.manualDownload) this.emit()
      }
    try {
      if (bundle.app) {
        if (!this.appStaged(bundle.app)) {
          await this.stageApp(bundle.app, abort.signal, reporter(bundle.app.sizeBytes))
        }
        done += bundle.app.sizeBytes
      }
      for (const model of bundle.models) {
        if (abort.signal.aborted) return
        if (!isModelStaged(this.deps.modelsDir, model)) {
          await this.deps.stageModel(model, reporter(model.sizeBytes), abort.signal)
        }
        done += model.sizeBytes
      }
      if (abort.signal.aborted || !this.bundle || bundleKey(this.bundle) !== key) return

      this.phase = 'ready'
      this.progress = null
      this.manualDownload = false
      this.deps.log(`AppUpdate: ${describe(bundle)} liegt bereit`)
      this.emit()
    } catch (err) {
      if (abort.signal.aborted) return
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.log(
        `AppUpdate: Download/Bereitstellen von ${describe(bundle)} gescheitert: ${reason}`
      )
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

  /** DMG laden, prüfen, App daneben kopieren und deren Version und Signatur prüfen. */
  private async stageApp(
    app: ManifestApp,
    signal: AbortSignal,
    onProgress: (percent: number) => void
  ): Promise<void> {
    const dir = join(this.deps.workDir, app.version)
    const dmg = join(dir, 'Therascript.dmg')
    const stagedApp = join(dir, 'Therascript.app')
    mkdirSync(dir, { recursive: true })
    if (!app.url.startsWith('https://')) throw new Error('Download-Adresse ist nicht verschlüsselt')
    const result = await this.deps.download(app.url, dmg, onProgress, signal)
    if (signal.aborted) throw new Error('Abgebrochen')
    if (!result.success) throw new Error(result.error ?? 'Download fehlgeschlagen')
    if ((await this.deps.sha256OfFile(dmg)) !== app.sha256) {
      rmSync(dmg, { force: true })
      throw new Error(
        'Die heruntergeladene Datei stimmt nicht mit der signierten Beschreibung überein'
      )
    }
    await this.deps.removeNow(stagedApp)
    await this.deps.extractApp(dmg, stagedApp, signal)
    await this.deps.verifyApp(stagedApp, app.version, signal)
    rmSync(dmg, { force: true })
    if (signal.aborted) throw new Error('Abgebrochen')
    const record = this.persisted()
    if (record?.app?.version === app.version) {
      this.deps.writePersisted({ ...record, app: { ...record.app, stagedAppPath: stagedApp } })
    }
  }

  cancelDownload(): void {
    if (!this.downloadAbort) return
    this.abortRun()
    if (this.phase === 'downloading') {
      this.phase = this.bundle ? 'available' : 'idle'
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
    } else if (this.phase === 'available' && this.bundle && this.startAutoDownload(this.bundle)) {
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

  /** Selbständig nur, solange es nicht wiederholt gescheitert ist (keine Neustart-Schleife). */
  private silentInstallAllowed(): boolean {
    return (
      this.deps.getAutoUpdate() &&
      (this.persisted()?.failedInstalls ?? 0) < MAX_SILENT_INSTALL_ATTEMPTS
    )
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
      (this.silentInstallAllowed() && this.deps.idleSeconds() >= IDLE_INSTALL_SECONDS)
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
    if (!this.installPending && !this.silentInstallAllowed()) return null
    if (this.deps.currentWork() !== null) return null
    this.quitPlan = { relaunch: false, startHidden: false }
    return this.quitPlan
  }

  /**
   * Der Aufrufer beendet danach mit app.exit(0), nicht app.quit() — ein
   * reguläres Beenden bricht macOS nach dem Umbenennen des eigenen Bundles ab.
   *
   * Nach dem geordneten Herunterfahren (Warteschlange gestoppt, Datenbank
   * geschlossen): nur Umbenennungen — schnell genug fürs Beenden, auch beim
   * Herunterfahren des Macs (AK 13, NFR 5). Zuerst die Modelle, zuletzt die
   * App; scheitert ein Teil, wird alles zurückgetauscht und es bleibt der
   * bisherige Stand (PC 2/4). Der nächste Start meldet es und versucht es
   * erneut.
   */
  performQuitInstall(plan: QuitInstallPlan): void {
    const record = this.persisted()
    const modelsDir = this.deps.modelsDir
    const ready =
      record !== null &&
      (!record.app || (!!record.app.stagedAppPath && existsSync(record.app.stagedAppPath))) &&
      record.models.every((m) => isModelStaged(modelsDir, m)) &&
      !hasLeftoverBackup(modelsDir, record.models)
    if (record && ready) {
      this.deps.writePersisted({ ...record, installAttemptedAt: this.deps.now().toISOString() })
      if (plan.relaunch) this.deps.setStartHidden(plan.startHidden)
      try {
        swapModelsIn(modelsDir, record.models)
        if (record.app?.stagedAppPath) {
          try {
            this.swapApp(record.app.stagedAppPath)
          } catch (err) {
            rollbackModels(modelsDir, record.models)
            throw err
          }
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

  /** Alte App beiseite, neue an ihren Platz; scheitert das zweite, kommt die alte zurück. */
  private swapApp(staged: string): void {
    const bundle = this.deps.bundlePath
    const previous = previousBundlePath(bundle)
    if (existsSync(previous)) renameSync(previous, `${previous}-${this.deps.now().getTime()}`)
    renameSync(bundle, previous)
    try {
      renameSync(staged, bundle)
    } catch (err) {
      renameSync(previous, bundle)
      throw err
    }
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
