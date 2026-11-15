import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs'
import { dirname, join, relative } from 'path'
import { app, BrowserWindow } from 'electron'
import { getDataDir } from '../db/connection'
import { getSettings, type AppSettings } from './SettingsService'
import { deleteInstalledVersion, setInstalledVersion } from './InstalledVersionsStore'
import {
  downloadFile,
  verifyFileSha256,
  extractTarGz,
  type DownloadProgress
} from './DownloadService'
import {
  isSlotModelGroup,
  type ModelGroup,
  type SlotModelGroup
} from '../../shared/validation/model-catalog-schemas'
import {
  MODEL_DEFINITIONS,
  RETIRED_MODELS,
  isPublished,
  type ModelDefinition
} from '../../shared/model-catalog'
import type { SearchModelFailureReason } from '../../shared/types/Search'
import type { ReconcileEvent, ReconcileReason } from '../../shared/types/ReconcileEvent'

export type { ModelGroup, ModelDefinition }

export interface ModelDownloadProgress {
  currentModel: string
  currentModelLabel: string
  currentModelProgress: number
  currentModelDownloaded: number
  currentModelTotal: number
  overallDownloaded: number
  overallTotal: number
  overallPercent: number
}

export type ModelDownloadStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: ModelDownloadProgress }
  | { state: 'extracting'; modelId: string }
  | { state: 'verifying'; modelId: string }
  | { state: 'complete' }
  | { state: 'error'; error: string; modelId: string }

let abortSignal: { aborted: boolean } | null = null

/** Läuft gerade ein Modell-Download (Ersteinrichtung oder Einstellungen)? */
export function isModelDownloadRunning(): boolean {
  return abortSignal !== null
}

// Noch nicht veröffentlichte Einträge (`published: false` oder Platzhalter-
// Hash, siehe `isPublished` in model-catalog.ts) stehen im Katalog, sind aber
// für alle Laufzeit-Zugriffe unsichtbar: kein Download, keine Zeile in den
// Einstellungen, isModelInstalled liefert false. Einzige Ausnahme ist das
// Suchmodell, wenn es von Hand am checkPath liegt (`getSearchModelLocation`).
const isPublishable = isPublished

const _unpublishedEntries = MODEL_DEFINITIONS.filter((m) => !isPublishable(m))
if (_unpublishedEntries.length > 0) {
  console.log(
    `[ModelDownloadService] noch nicht veröffentlicht (für Laufzeit-Zugriffe ausgeblendet): ` +
      _unpublishedEntries.map((m) => m.id).join(', ')
  )
}

export function getModelDefinitions(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter(isPublishable)
}

export function getModelsByGroup(group: ModelGroup): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.group === group && isPublishable(m))
}

/** Backward-Compat-Alias — weiterhin verwendet von First-Launch + Update-Check. */
export function getAsrModels(): ModelDefinition[] {
  return getModelsByGroup('asr')
}

export function getRequiredModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.isRequired === true && isPublishable(m))
}

export function getModelById(id: string): ModelDefinition | null {
  const def = MODEL_DEFINITIONS.find((m) => m.id === id)
  return def && isPublishable(def) ? def : null
}

/**
 * Liefert die aktuell aktive Model-ID für eine Gruppe aus den Settings, oder
 * `null` wenn kein ausführbares Modell aktiv ist. "Ausführbar" heisst:
 *   1. die Slot-Spalte enthält eine ID,
 *   2. die ID existiert im Katalog,
 *   3. die zugehörige `checkPath`-Datei liegt auf Disk.
 *
 * Issue #84 / Story A: Diese defensive Disk-Prüfung ist der Hot-Path-Backstop
 * gegen "App glaubt Aktiv, aber Datei fehlt"-Inkonsistenzen (z. B. nach manuellem
 * Löschen im Finder, nach abgebrochenem Update, nach Spotlight-Cleanup). Der
 * Bootstrap-Reconciler `reconcileActiveModels` repariert solche Zustände
 * proaktiv beim App-Start; `getActiveModelId` ist die zweite Verteidigungslinie
 * für Inkonsistenzen, die _während_ einer Session entstehen.
 */
export function getActiveModelId(group: ModelGroup): string | null {
  const id = getActiveModelIdBelief(group)
  if (id === null) return null
  if (!isModelInstalled(id)) return null
  return id
}

/**
 * Issue #84 / Story E follow-up — raw settings-belief without the disk
 * presence check. Used by the catalog handler to expose the "user has
 * marked this active" bit independently of "the file is there", so the
 * Settings UI can surface the `inconsistent` ModelStatusBadge state when
 * the two diverge (e.g. user deletes the file in Finder mid-session and
 * re-opens Settings → Modelle before restarting).
 *
 * Executors must keep using `getActiveModelId` (the disk-checked variant);
 * trusting belief without the file check would re-introduce the original
 * trust gap this epic closes.
 */
export function getActiveModelIdBelief(group: ModelGroup): string | null {
  // Gruppen ohne Slot (search) haben nie ein «aktives» Modell — kein Wurf:
  // Aufrufer wie Provenienz oder Auto-Activate laufen über alle Gruppen
  if (!isSlotModelGroup(group)) return null
  const active = getSettings().get('activeModels')
  const id: string | null = active[GROUP_TO_SETTINGS_KEY[group]] ?? null
  if (id === null || id === '') return null
  return id
}

/**
 * Liefert den absoluten Pfad zum aktiven Modell einer Gruppe — oder `null`,
 * wenn die Gruppe kein installiertes aktives Modell hat. Aufrufer (Executors,
 * Pipeline-Plan) müssen den Null-Fall explizit behandeln (Pflicht-Gruppen:
 * Fehler werfen; optionale: Step skippen).
 */
export function getActiveModelPath(group: ModelGroup): string | null {
  const id = getActiveModelId(group)
  if (id === null) return null
  const def = getModelById(id)
  if (!def) return null
  return join(getModelsDir(), def.relativePath)
}

/**
 * Modelle, die auf First-Launch heruntergeladen werden müssen, in Pipeline-Reihenfolge:
 *   1. aktives ASR-Modell (Transkription, User-wählbar; ohne gültiges aktives der Standard)
 *   2. alle isRequired-Modelle in Definition-Reihenfolge
 *      (derzeit: pyannote-suite für Sprechererkennung, flair für Pseudonymisierung)
 *   3. zuletzt die `deferrable`-Pflichtmodelle (Suchmodell, sobald veröffentlicht,
 *      #209 AK 21) — scheitert nur eines davon, öffnet sich die App trotzdem
 *
 * Die Pipeline-Wahl innerhalb der pyannote-Suite (3.1 vs community-1) ist
 * eine Runtime-Konfiguration und beeinflusst den Download nicht — die Suite
 * enthält beide Pipelines.
 *
 * `activeDiarId` wird aus Backward-Compat-Gründen akzeptiert, aber ignoriert.
 */
export function getModelsToLoadOnFirstLaunch(
  activeAsrId: string | null,
  _activeDiarId?: string | null
): ModelDefinition[] {
  const seen = new Set<string>()
  const out: ModelDefinition[] = []

  // Ohne gültiges aktives ASR-Modell (Slot leer oder ID nicht mehr im Katalog,
  // z. B. nach dem Ausmustern des einzigen installierten Modells) den Standard
  // laden — sonst hätte die App nach dem Ersteinrichtungs-Bildschirm gar keins.
  const activeAsr =
    (activeAsrId ? getModelById(activeAsrId) : null) ?? getModelById(REQUIRED_GROUP_DEFAULTS.asr)
  if (activeAsr && activeAsr.group === 'asr' && !seen.has(activeAsr.id)) {
    seen.add(activeAsr.id)
    out.push(activeAsr)
  }
  const required = getRequiredModels()
  for (const m of [
    ...required.filter((r) => r.deferrable !== true),
    ...required.filter((r) => r.deferrable === true)
  ]) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

/**
 * Prüft, ob die Minimal-Menge (required + aktives ASR + aktives Diarization) installiert ist.
 * Wenn `activeAsrId` null ist (z. B. nach Reconcile auf einer frisch installierten App),
 * fehlt strukturell ein ASR-Modell → false; FirstLaunchScreen wird angezeigt.
 *
 * `deferrable`-Modelle zählen NICHT (#210 AK 3): ein Bestandsnutzer ohne
 * Suchmodell sieht nie den Ersteinrichtungs-Bildschirm, der
 * SearchModelProvisioner lädt es im Hintergrund nach.
 */
export function checkRequiredAndActiveExist(
  activeAsrId: string | null,
  activeDiarId: string | null
): boolean {
  if (activeAsrId === null) return false
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId, activeDiarId).filter(
    (m) => m.deferrable !== true
  )
  return toCheck.every((m) => existsSync(join(modelsDir, m.checkPath)))
}

/**
 * Prüft, ob ein einzelnes Modell installiert ist (für UI-Status).
 */
export function isModelInstalled(id: string): boolean {
  const def = getModelById(id)
  if (!def) return false
  return existsSync(join(getModelsDir(), def.checkPath))
}

export function getModelsDir(): string {
  return join(getDataDir(), 'models')
}

// ─── Suchmodell (Epic #192) ───────────────────────────────────────────────────

/** Übersteuert den Modellpfad der Suche — nur ausserhalb der gepackten App. */
export const SEARCH_MODEL_DIR_ENV = 'THERASCRIPT_SEARCH_MODEL_DIR'

/**
 * Katalogeintrag des Suchmodells — auch, wenn er noch nicht veröffentlicht
 * ist (`published: false`). Wer laden oder anbieten will, prüft
 * `isPublished` selbst; für «liegt es schon da?» zählt der Schalter nicht.
 */
export function getSearchModelDefinition(): ModelDefinition | null {
  return MODEL_DEFINITIONS.find((m) => m.group === 'search') ?? null
}

export interface SearchModelLocation {
  def: ModelDefinition
  /** Verzeichnis des entpackten Modells (config.json, model.safetensors, tokenizer.json). */
  dir: string
  /** Datei, deren Existenz «vollständig entpackt» bedeutet (READY). */
  readyPath: string
  /** true = per THERASCRIPT_SEARCH_MODEL_DIR übersteuert (nur Entwicklung). */
  overridden: boolean
}

function isPackagedApp(): boolean {
  try {
    return app.isPackaged === true
  } catch {
    // Ohne Electron (Tests, Skripte): wie die Entwicklung behandeln
    return false
  }
}

/**
 * Wo das Suchmodell liegt bzw. hingehört. In der Entwicklung (`app.isPackaged
 * === false`) übersteuert `THERASCRIPT_SEARCH_MODEL_DIR` den Ort — in der
 * gepackten App nie, sonst könnte eine geerbte Umgebungsvariable ein
 * fremdes Modell unterschieben.
 */
export function getSearchModelLocation(): SearchModelLocation | null {
  const def = getSearchModelDefinition()
  if (!def) return null
  const marker = relative(def.relativePath, def.checkPath)
  const override = isPackagedApp() ? undefined : process.env[SEARCH_MODEL_DIR_ENV]
  if (override && override.trim() !== '') {
    return { def, dir: override, readyPath: join(override, marker), overridden: true }
  }
  const modelsDir = getModelsDir()
  return {
    def,
    dir: join(modelsDir, def.relativePath),
    readyPath: join(modelsDir, def.checkPath),
    overridden: false
  }
}

/**
 * Ist das Suchmodell vollständig da? Unabhängig vom Veröffentlichungs-
 * Schalter: von Hand am checkPath entpackt (oder per Umgebungsvariable in
 * der Entwicklung) zählt es als installiert.
 */
export function isSearchModelInstalled(): boolean {
  const loc = getSearchModelLocation()
  return loc !== null && existsSync(loc.readyPath)
}

/**
 * Persist that a model with the given catalog hash is installed on disk.
 * Called from the download paths immediately after SHA-256 verification +
 * archive extraction succeed — at that point we KNOW the catalog hash matches
 * the bytes on disk (we just verified). Writing the real hash here closes the
 * Erstinstallation false-positive update banner: the next manifest check
 * compares string-equal against this hash and only flags an update when the
 * manifest publishes a new version.
 *
 * Distinct from the `''` sentinel written by `migrateInstalledVersions` for
 * pre-existing installs from app builds that did not yet track per-install
 * hashes; those entries are healed lazily by `UpdateCheckService.checkForUpdates`.
 */
export function recordInstalledVersion(id: string, sha256: string): void {
  setInstalledVersion(id, {
    version: 'installed',
    sha256,
    installedAt: new Date().toISOString()
  })
}

export function checkModelsExist(): boolean {
  const active = getSettings().get('activeModels')
  return checkRequiredAndActiveExist(active.transcription, active.diarization)
}

export function getModelsToLoad(): ModelDefinition[] {
  const active = getSettings().get('activeModels')
  return getModelsToLoadOnFirstLaunch(active.transcription, active.diarization)
}

export function getOverallModelSize(): number {
  return getModelsToLoad().reduce((sum, m) => sum + m.sizeBytes, 0)
}

function sendProgress(status: ModelDownloadStatus): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send('modelDownload:status', status)
  }
}

function assertFinalSha256(model: ModelDefinition): void {
  if (model.sha256.startsWith('PENDING_')) {
    throw new Error(
      `Modell "${model.label}" (${model.id}) hat noch keinen finalen SHA-256 ` +
        `(Wert: "${model.sha256}"). Das deutet auf ein nicht abgeschlossenes Packaging hin — ` +
        `erst scripts/package-models.sh + scripts/publish-manifest.sh ausführen und die Hashes setzen.`
    )
  }
}

/** Warum ein Modell nicht installiert werden konnte — 'aborted' = abgebrochen, kein Fehler. */
export type ModelInstallFailureReason = SearchModelFailureReason | 'aborted'

export type ModelInstallResult =
  | {
      ok: true
      /** Liegt der checkPath nach dem Entpacken wirklich da? Nur dann ist die Fassung eingetragen. */
      installed: boolean
    }
  | { ok: false; reason: ModelInstallFailureReason; error: string }

export interface ModelInstallOptions {
  signal: { aborted: boolean }
  /**
   * Bricht das Signal auch das Entpacken ab (tar wird beendet)? Nur der
   * SearchModelProvisioner setzt das — beim Beenden soll kein tar weiterlaufen.
   * Ersteinrichtung und Einstellungen bleiben, wie sie waren. Ein halb
   * entpacktes Modell heilt sich ohnehin selbst: READY ist der letzte Eintrag
   * im Tarball, ohne READY gilt es als nicht installiert.
   */
  abortExtraction?: boolean
  onProgress?: (progress: DownloadProgress) => void
  onPhase?: (phase: 'verifying' | 'extracting') => void
}

const DISK_FULL = /ENOSPC|No space left|Kein Platz/i
const LOCAL_FILE_ERROR = /EACCES|EPERM|EROFS|EISDIR|nicht finalisiert/i

/** Antwort des Servers mit Fehlerstatus (downloadFile meldet «HTTP <Status>»). */
const HTTP_STATUS = /^HTTP \d{3}\b/

/** Ordnet die Fehlermeldung von downloadFile einem Grund zu. */
export function classifyDownloadError(error: string): ModelInstallFailureReason {
  if (error === 'Aborted') return 'aborted'
  if (HTTP_STATUS.test(error)) return 'server'
  if (DISK_FULL.test(error)) return 'disk-space'
  if (LOCAL_FILE_ERROR.test(error)) return 'unknown'
  return 'network'
}

function fileSize(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null
  } catch {
    return null
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* non-fatal */
  }
}

/**
 * Lädt, prüft und entpackt ein Katalog-Modell an seinen Platz — der gemeinsame
 * Kern von Ersteinrichtung, Einstellungen und SearchModelProvisioner. Wirft
 * nie; das Ergebnis nennt den Grund eines Fehlschlags. Fasst den globalen
 * Download-Zustand (`isModelDownloadRunning`, WorkGuard) NICHT an — das tun
 * die Aufrufer, die als Arbeit zählen sollen.
 */
export async function installCatalogModel(
  def: ModelDefinition,
  opts: ModelInstallOptions
): Promise<ModelInstallResult> {
  const modelsDir = getModelsDir()
  try {
    assertFinalSha256(def)
  } catch (err) {
    return { ok: false, reason: 'unknown', error: err instanceof Error ? err.message : String(err) }
  }

  // Archive: erst nach models/<id>.tar.gz, dann entpacken; flache Dateien direkt ans Ziel
  const targetPath = def.archive
    ? join(modelsDir, `${def.id}.tar.gz`)
    : join(modelsDir, def.relativePath)
  try {
    // Ordner optionaler Gruppen (summarization, search) legt erst der erste Download an
    mkdirSync(dirname(targetPath), { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: DISK_FULL.test(message) ? 'disk-space' : 'unknown', error: message }
  }

  const partial = `${targetPath}.partial`
  let result: { success: boolean; error?: string; sha256?: string }
  // Eine .partial in voller (oder zu grosser) Länge liesse den Range-Request
  // mit HTTP 416 scheitern — und das bei jedem Versuch. Passt sie exakt, wird
  // sie geprüft und übernommen, sonst verworfen.
  const partialSize = fileSize(partial)
  if (partialSize !== null && partialSize >= def.sizeBytes) {
    if (partialSize === def.sizeBytes && (await verifyFileSha256(partial, def.sha256))) {
      try {
        renameSync(partial, targetPath)
      } catch {
        rmSync(partial, { force: true })
      }
    } else {
      rmSync(partial, { force: true })
    }
  }
  if (existsSync(targetPath) && !existsSync(partial) && fileSize(targetPath) === def.sizeBytes) {
    // Schon vollständig geladen (übernommene .partial oder Abbruch vor dem Entpacken)
    result = { success: true }
  } else {
    result = await downloadFile(def.url, targetPath, (p) => opts.onProgress?.(p), opts.signal)
    if (!result.success && result.error?.startsWith('HTTP 416')) {
      // Range passt nicht zum Objekt auf dem Server: neu ohne Range
      rmSync(partial, { force: true })
      result = await downloadFile(def.url, targetPath, (p) => opts.onProgress?.(p), opts.signal)
    }
  }
  if (!result.success) {
    const error = result.error ?? 'Download fehlgeschlagen'
    return { ok: false, reason: classifyDownloadError(error), error }
  }

  // Bevorzugt den beim Streamen mitberechneten Hash — erspart den zweiten
  // Full-Read; Fallback (Resume-Downloads) liest die Datei nochmal.
  opts.onPhase?.('verifying')
  const valid = result.sha256
    ? result.sha256 === def.sha256
    : await verifyFileSha256(targetPath, def.sha256)
  if (!valid) {
    tryUnlink(targetPath)
    return {
      ok: false,
      reason: 'checksum',
      error: `SHA-256-Prüfung fehlgeschlagen für ${def.label}`
    }
  }

  if (def.archive) {
    opts.onPhase?.('extracting')
    const extractDir = join(modelsDir, def.relativePath)
    let extract: { success: boolean; error?: string }
    try {
      mkdirSync(extractDir, { recursive: true })
      extract = await extractTarGz(
        targetPath,
        extractDir,
        opts.abortExtraction ? opts.signal : undefined
      )
    } catch (err) {
      extract = { success: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (!extract.success && extract.error === 'Aborted') {
      // Archiv bleibt liegen: der nächste Versuch entpackt es ohne neuen Download
      return { ok: false, reason: 'aborted', error: 'Aborted' }
    }
    if (!extract.success) {
      tryUnlink(targetPath)
      const error = extract.error ?? 'Entpacken fehlgeschlagen'
      return { ok: false, reason: DISK_FULL.test(error) ? 'disk-space' : 'extract', error }
    }
  }

  // Only record the install hash once `checkPath` is observable on disk —
  // a successful tar exit doesn't guarantee the inner file we use as the
  // installed-marker actually landed (malformed archive, disk-full mid-write).
  // Skipping the recordInstalledVersion call here lets `migrateInstalledVersions`
  // / lazy heal recover on the next manifest check rather than persisting a
  // hash for a half-installed model.
  const installed = existsSync(join(modelsDir, def.checkPath))
  if (installed) recordInstalledVersion(def.id, def.sha256)
  return { ok: true, installed }
}

export async function startModelDownload(): Promise<void> {
  if (abortSignal && !abortSignal.aborted) return // Already downloading

  const signal = { aborted: false }
  abortSignal = signal
  const modelsDir = getModelsDir()
  const overallTotal = getOverallModelSize()
  let overallDownloaded = 0

  for (const model of getModelsToLoad()) {
    // Skip already downloaded/extracted models
    if (existsSync(join(modelsDir, model.checkPath))) {
      overallDownloaded += model.sizeBytes
      continue
    }

    if (signal.aborted) {
      sendProgress({ state: 'error', error: 'Download abgebrochen', modelId: model.id })
      abortSignal = null
      return
    }

    const baseOverall = overallDownloaded
    const result = await installCatalogModel(model, {
      signal,
      onProgress: (progress) => {
        sendProgress({
          state: 'downloading',
          progress: {
            currentModel: model.id,
            currentModelLabel: model.label,
            currentModelProgress: progress.percent,
            currentModelDownloaded: progress.downloadedBytes,
            currentModelTotal: progress.totalBytes,
            overallDownloaded: baseOverall + progress.downloadedBytes,
            overallTotal,
            overallPercent: Math.round(
              ((baseOverall + progress.downloadedBytes) / overallTotal) * 100
            )
          }
        })
      },
      onPhase: (phase) => sendProgress({ state: phase, modelId: model.id })
    })

    if (!result.ok) {
      // Ein aufschiebbares Modell (Suche) sperrt die Ersteinrichtung nicht:
      // die App öffnet sich, der SearchModelProvisioner versucht es weiter
      if (model.deferrable === true && result.reason !== 'aborted') {
        console.warn(
          `[first-launch] ${model.id} übersprungen (${result.reason}): ${result.error} — Provisioner übernimmt`
        )
        overallDownloaded += model.sizeBytes
        continue
      }
      sendProgress({ state: 'error', error: result.error, modelId: model.id })
      abortSignal = null
      return
    }
    overallDownloaded += model.sizeBytes
  }

  // All models downloaded successfully
  getSettings().set('modelsDownloaded', true)
  // Re-reconcile: the boot reconciler may have cleared a required slot whose
  // checkPath was missing (v1→v2-NER-Upgrade-Pfad) — the download just made
  // the model observable again, so the slot is re-promoted NOW instead of at
  // the next restart. Closes the window in which sessions would record
  // ner:null provenance and Settings would show the model as inactive.
  reconcileActiveModels()
  sendProgress({ state: 'complete' })
  abortSignal = null
}

export function abortModelDownload(): void {
  if (abortSignal) {
    abortSignal.aborted = true
  }
}

/**
 * Lädt ein einziges optionales Modell herunter (z.B. ASR-Variante oder
 * Summarization-Modell). Pflicht-Modelle (`isRequired`) laufen via
 * startModelDownload auf First-Launch (bzw. das Suchmodell über den
 * SearchModelProvisioner) und werden hier abgewiesen.
 *
 * Sendet denselben `modelDownload:status`-Channel wie startModelDownload,
 * damit die bestehende UI-Progress-Anzeige wiederverwendbar bleibt.
 */
export async function downloadSingleModel(id: string): Promise<void> {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Download: unbekanntes Modell "${id}"`)
  }
  if (def.isRequired) {
    throw new Error(
      `Download: "${def.label}" ist ein Pflicht-Modell — wird über First-Launch geladen`
    )
  }
  if (abortSignal && !abortSignal.aborted) {
    throw new Error('Download: bereits aktiv — zuerst abbrechen')
  }

  const signal = { aborted: false }
  abortSignal = signal

  if (existsSync(join(getModelsDir(), def.checkPath))) {
    sendProgress({ state: 'complete' })
    abortSignal = null
    return
  }

  const result = await installCatalogModel(def, {
    signal,
    onProgress: (progress) => {
      sendProgress({
        state: 'downloading',
        progress: {
          currentModel: def.id,
          currentModelLabel: def.label,
          currentModelProgress: progress.percent,
          currentModelDownloaded: progress.downloadedBytes,
          currentModelTotal: progress.totalBytes,
          overallDownloaded: progress.downloadedBytes,
          overallTotal: def.sizeBytes,
          overallPercent: progress.percent
        }
      })
    },
    onPhase: (phase) => sendProgress({ state: phase, modelId: def.id })
  })

  // Error-Reporting läuft ausschliesslich via thrown Error → IPC-Rejection → Renderer-Toast.
  // Kein sendProgress({state:'error'}) hier, sonst würde der Renderer den Toast doppelt zeigen
  // (einmal via modelDownload:status-Subscription, einmal via IPC-Catch in ModelsSettings).
  if (!result.ok) {
    abortSignal = null
    throw new Error(result.error)
  }

  // Auto-activate optional models with empty slots — only when checkPath is
  // really on disk, sonst würde setActiveModel mit "nicht installiert" werfen.
  if (result.installed) autoActivateAfterDownload(def.id)
  sendProgress({ state: 'complete' })
  abortSignal = null
}

/**
 * Entfernt ein Modell und alles, was ein Download oder Update dafür anlegen
 * kann: `relativeTarget` (Datei oder Verzeichnis) samt `.partial` eines
 * abgebrochenen Downloads, das Archiv `<id>.tar.gz` (auch `.partial`) und
 * `.backup/<id>` eines abgebrochenen Update-Swaps. Ein Fehler beim Haupt-Ziel
 * wird geworfen; Reste werden best effort entfernt.
 */
function removeModelArtifacts(id: string, relativeTarget: string): void {
  const modelsDir = getModelsDir()
  const target = join(modelsDir, relativeTarget)
  rmSync(target, { recursive: true, force: true })
  const archive = join(modelsDir, `${id}.tar.gz`)
  for (const leftover of [
    `${target}.partial`,
    archive,
    `${archive}.partial`,
    join(modelsDir, '.backup', id)
  ]) {
    try {
      rmSync(leftover, { recursive: true, force: true })
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Löscht ein einzelnes Modell von Disk. Verboten für:
 *   - unbekannte IDs
 *   - Pflicht-Modelle (isRequired, z.B. flair NER + pyannote-Suite)
 *   - das aktuell aktive ASR-Modell (User muss zuerst auf ein anderes
 *     Modell wechseln, sonst hätte die Transkriptions-Pipeline keinen
 *     gültigen Modell-Pfad mehr)
 *
 * Optionale Modelle (z.B. Summarization) ohne harten Active-Guard:
 *   - Wenn das aktive Summarization-Modell gelöscht wird, schaltet der
 *     SummarizationExecutor automatisch in den Skip-Modus
 *     (isModelInstalled = false). Die Pipeline läuft einfach ohne
 *     Zusammenfassung weiter, kein Fehler.
 */
export async function deleteModel(id: string): Promise<void> {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Löschen: unbekanntes Modell "${id}"`)
  }
  // Das Suchmodell wird weder aktiviert noch gelöscht — ohne es gäbe es keine
  // Suche nach Bedeutung, und der Provisioner lüde es sofort wieder
  if (def.group === 'search') {
    throw new Error(`Löschen: "${def.label}" gehört zur Suche und ist nicht löschbar`)
  }
  if (def.isRequired) {
    throw new Error(`Löschen: "${def.label}" ist ein Pflicht-Modell und nicht löschbar`)
  }

  const settings = getSettings()
  const active = settings.get('activeModels')
  if (def.group === 'asr' && active.transcription === id) {
    throw new Error(
      `Löschen: "${def.label}" ist aktuell als ASR-Modell aktiv. Zuerst anderes Modell aktivieren.`
    )
  }

  removeModelArtifacts(id, def.checkPath)
  deleteInstalledVersion(id)

  // Optionale Gruppen: war das gelöschte Modell aktiv, Active-Slot räumen,
  // damit die UI nicht „Aktiv" auf etwas Nichtexistentem anzeigt. Erlaubt durch
  // OPTIONAL_GROUPS-Whitelist — Pflichtgruppen sind durch isRequired+ASR-Guard
  // bereits oben geschützt.
  if (def.group && isSlotModelGroup(def.group) && OPTIONAL_GROUPS.has(def.group)) {
    const slot = GROUP_TO_SETTINGS_KEY[def.group]
    if (active[slot] === id) {
      settings.set('activeModels', { ...settings.get('activeModels'), [slot]: null })
    }
  }
}

// Explizites Mapping Group → Settings-Key. Der TypeScript-Compiler erzwingt Vollständigkeit:
// Wird ModelGroup um einen neuen Wert erweitert, schlägt der Build fehl,
// solange das Mapping nicht erweitert wird. Das verhindert silent-wrong-key-writes.
//
// Die Value-Union wird aus AppSettings['activeModels'] abgeleitet, damit die
// Mapping-Werte automatisch synchron bleiben mit den Property-Namen in den
// Settings — Tippfehler oder umbenannte Felder werden vom Compiler gefangen,
// statt dass eine zweite hand-gepflegte Union nötig wäre.
//
// Nur Gruppen MIT Slot (SlotModelGroup) — `search` hat keinen; wer eine Gruppe
// auf einen Slot abbildet, muss das vorher mit isSlotModelGroup prüfen.
const GROUP_TO_SETTINGS_KEY: Record<SlotModelGroup, keyof AppSettings['activeModels']> = {
  asr: 'transcription',
  diarization: 'diarization',
  ner: 'ner',
  summarization: 'summarization'
}

/**
 * Wechselt das aktive Modell einer Gruppe. Das Modell muss:
 *   - existieren (bekannte ID)
 *   - in der angegebenen Gruppe liegen
 *   - auf Disk installiert sein
 */
export function setActiveModel(group: SlotModelGroup, id: string): void {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Aktivieren: unbekanntes Modell "${id}"`)
  }
  if (def.group !== group) {
    throw new Error(
      `Aktivieren: "${def.label}" ist ${def.group ?? 'ungruppiert'}, erwartet wurde ${group}`
    )
  }
  if (!isModelInstalled(id)) {
    throw new Error(`Aktivieren: "${def.label}" ist nicht installiert`)
  }
  const settings = getSettings()
  const current = settings.get('activeModels')
  settings.set('activeModels', { ...current, [GROUP_TO_SETTINGS_KEY[group]]: id })
}

/**
 * Leert den Active-Slot einer optionalen Gruppe — der zugehörige Pipeline-Step
 * wird zur Laufzeit geräuschlos übersprungen (siehe SummarizationExecutor).
 * Erlaubt nur für optionale Gruppen, damit ASR/Diarization/NER nie versehentlich
 * deaktiviert werden können.
 */
const OPTIONAL_GROUPS: ReadonlySet<SlotModelGroup> = new Set(['summarization'])

export function clearActiveModel(group: SlotModelGroup): void {
  if (!OPTIONAL_GROUPS.has(group)) {
    throw new Error(`Deaktivieren: Gruppe "${group}" ist nicht optional`)
  }
  const settings = getSettings()
  const current = settings.get('activeModels')
  settings.set('activeModels', { ...current, [GROUP_TO_SETTINGS_KEY[group]]: null })
}

/** Backward-Compat-Alias. */
export function setActiveAsrModel(id: string): void {
  setActiveModel('asr', id)
}

/**
 * Auto-Activate-Hook für optionale Modelle. Mit Default = null für optionale
 * Gruppen würde ein gerade heruntergeladenes Modell sonst sofort wieder geskippt
 * werden, weil der aktive Slot leer ist. Diese Funktion läuft nach erfolgreichem
 * Download und aktiviert das Modell automatisch, wenn:
 *   - die Gruppe optional ist (OPTIONAL_GROUPS),
 *   - der aktive Slot der Gruppe aktuell null ist,
 *   - das Modell installiert ist (Datei-Check via setActiveModel).
 *
 * Required Groups laufen über FirstLaunchScreen / Reconciler — die regeln
 * Activate-Logik selbst.
 */
export function autoActivateAfterDownload(modelId: string): void {
  const def = getModelById(modelId)
  if (!def || !def.group) return
  const group = def.group
  if (!isSlotModelGroup(group) || !OPTIONAL_GROUPS.has(group)) return
  const currentBelief = getActiveModelIdBelief(group)
  if (currentBelief !== null) return
  // setActiveModel verifiziert isModelInstalled — wenn Download teilweise fehlschlug
  // (Datei nicht da), wirft setActiveModel und der Auto-Activate ist ein No-Op
  // statt Lautstärke. Wir loggen + swallow.
  try {
    setActiveModel(group, modelId)
    console.log(`[auto-activate] ${group}: ${modelId} (slot was null)`)
  } catch (err) {
    console.warn(`[auto-activate] failed for ${modelId}:`, err)
  }
}

// ─── Bootstrap reconcile (Issue #84 / Story C) ────────────────────────────────
// "Disk ist die einzige Wahrheit": die App darf keinen Belief-State haben, der
// von der beobachtbaren Realität abweichen kann. Wo sie es heute hat (Slot
// zeigt auf gelöschte Datei nach Finder-Mülleimer-Aktion / abgebrochenem
// Update / Disk-Korruption), gewinnt die Realität — beim nächsten Bootstrap.

/**
 * Pipeline-Pflichtgruppen im Sinne der Reconcile-Logik: ohne ein installiertes
 * Modell in jeder dieser Gruppen ist die Audio-Pipeline nicht ausführbar.
 * `summarization` lebt in OPTIONAL_GROUPS (oben definiert).
 */
const REQUIRED_GROUPS_FOR_RECONCILE: ReadonlySet<SlotModelGroup> = new Set([
  'asr',
  'diarization',
  'ner'
])

/**
 * Required-Group-Defaults — werden vom Reconciler als bevorzugtes Auto-Activate-Ziel
 * verwendet (`pickInstalledForGroup`). Optionale Gruppen leben NICHT in dieser Map,
 * weil ihr initialer aktiver Slot per Invariante `null` ist (siehe `defaultActiveModelFor`).
 */
const REQUIRED_GROUP_DEFAULTS: Record<'asr' | 'diarization' | 'ner', string> = {
  asr: 'whisper-large-v3-turbo',
  diarization: 'pyannote-suite',
  ner: 'flair-ner-german-large'
}

/**
 * Single source of truth für den initialen aktiven Slot pro Gruppe.
 * - Required Groups: Catalog-Default (asr/diarization/ner).
 * - Optional Groups: `null` — Pipeline-Step skippt zur Laufzeit, bis User
 *   das Modell explizit herunterlädt (Auto-Activate via `downloadSingleModel`).
 *
 * Konsumiert von der Upgrade-Migration in `SettingsService.ts`. Die `defaults`-
 * Konstante in SettingsService selbst hardcodet die Werte parallel — Helper kann
 * dort wegen zirkulärer Modul-Init nicht aufgerufen werden.
 */
export function defaultActiveModelFor(group: SlotModelGroup): string | null {
  if (OPTIONAL_GROUPS.has(group)) return null
  return REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
}

function pickInstalledForGroup(group: SlotModelGroup): string | null {
  const preferred = REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
  if (preferred && isModelInstalled(preferred)) return preferred
  for (const m of getModelsByGroup(group)) {
    if (isModelInstalled(m.id)) return m.id
  }
  return null
}

export interface ReconcileRepair {
  group: SlotModelGroup
  fromModelId: string | null
  toModelId: string | null
  reason: ReconcileReason
}

/**
 * Reconciler — läuft beim App-Start (NACH `initSettings()`, VOR
 * `createWindow()`) und ein zweites Mal am Ende von `startModelDownload()`,
 * damit ein beim Boot geleerter required-Slot direkt nach dem First-Launch-
 * Download re-promotet wird statt erst beim nächsten Start. Geht jede
 * Modell-Gruppe durch und stellt das Invariant sicher:
 *   "Der active-Slot zeigt entweder auf ein installiertes Katalog-Modell
 *    oder ist null."
 *
 * Inkonsistenzen werden so repariert:
 *   - Pflicht-Gruppe mit fehlendem aktiven Modell → installierten Katalog-
 *     Default aktivieren (oder ein anderes installiertes Gruppenmitglied,
 *     wenn der Default nicht installiert ist); andernfalls null + der
 *     FirstLaunchScreen wird angezeigt.
 *   - Optionale Gruppe mit fehlendem aktiven Modell → null (Pipeline-Step
 *     wird zur Laufzeit übersprungen).
 *
 * Wird auf wirklich frischen Installationen (`modelsDownloaded === false`)
 * komplett übersprungen — dort ist der FirstLaunchScreen das Gate. Jede
 * Reparatur wird als `pending` ReconcileEvent persistiert, was den Dot im
 * den Hinweispunkt der Seitenleiste und das Banner in Settings → Modelle treibt.
 *
 * Performance: nur `existsSync`-Calls (≤ Katalog-Größe, derzeit 6), kein I/O
 * darüber hinaus. Crash-sicher per design — Disk ist Source of Truth,
 * electron-store ist Cache; ein Crash mitten im Write heilt sich beim nächsten
 * Bootstrap.
 */
export function reconcileActiveModels(): ReadonlyArray<ReconcileRepair> {
  const settings = getSettings()
  if (settings.get('modelsDownloaded') !== true) return []

  // Nur Gruppen mit Slot — das Suchmodell hat keinen, über ihn wacht der
  // SearchModelProvisioner (fehlt es, wird es nachgeladen, nicht «repariert»)
  const groups: readonly SlotModelGroup[] = ['asr', 'diarization', 'ner', 'summarization']
  const repairs: ReconcileRepair[] = []
  let nextActive = { ...settings.get('activeModels') }
  let activeChanged = false

  for (const group of groups) {
    const slot = GROUP_TO_SETTINGS_KEY[group]
    const current: string | null = nextActive[slot] ?? null

    // Steady state — slot points at an installed catalog model.
    if (current !== null && isModelInstalled(current)) continue

    // Steady state for optional groups the user has deactivated — no event.
    if (current === null && !REQUIRED_GROUPS_FOR_RECONCILE.has(group)) continue

    let next: string | null
    let reason: ReconcileReason

    if (REQUIRED_GROUPS_FOR_RECONCILE.has(group)) {
      next = pickInstalledForGroup(group)
      reason = next === null ? 'model-removed' : 'default-promoted'
    } else {
      next = null
      reason = 'group-cleared'
    }

    if (next === current) continue

    nextActive = { ...nextActive, [slot]: next }
    activeChanged = true
    repairs.push({ group, fromModelId: current, toModelId: next, reason })
  }

  if (activeChanged) {
    settings.set('activeModels', nextActive)
  }

  if (repairs.length > 0) {
    let events = settings.get('reconcileEvents') ?? []
    let eventsChanged = false
    for (const r of repairs) {
      // Round-trip collapse: this repair exactly inverts an earlier event
      // (X → null → X, e.g. the v1→v2-NER-Upgrade: boot-reconcile cleared the
      // slot, the re-download made the model observable again). Net state is
      // unchanged for the user — drop the stale event instead of stacking a
      // misleading "Modell entfernt" + "Standard aktiviert" banner pair.
      const inverseIdx = events.findIndex(
        (e) => e.group === r.group && e.fromModelId === r.toModelId && e.toModelId === r.fromModelId
      )
      if (inverseIdx >= 0) {
        events = [...events.slice(0, inverseIdx), ...events.slice(inverseIdx + 1)]
        eventsChanged = true
        continue
      }
      // Ein ausgemustertes Modell hat den Slot geleert (retireObsoleteModels),
      // jetzt rückt ein Nachfolger nach — direkt beim Boot oder erst nach dem
      // Ersteinrichtungs-Download. Eine Meldung «X ersetzt durch Y» statt
      // «entfernt» plus «Standard aktiviert».
      const retiredIdx = events.findIndex(
        (e) =>
          e.group === r.group &&
          e.reason === 'model-retired' &&
          e.toModelId === null &&
          r.fromModelId === null
      )
      if (retiredIdx >= 0 && r.toModelId !== null) {
        const folded = {
          ...events[retiredIdx],
          toModelId: r.toModelId,
          toLabel: modelLabel(r.toModelId),
          status: 'pending' as const
        }
        events = events.map((e, i) => (i === retiredIdx ? folded : e))
        eventsChanged = true
        continue
      }
      events = [...events, newReconcileEvent(r)]
      eventsChanged = true
    }
    if (eventsChanged) {
      settings.set('reconcileEvents', events)
    }
    for (const r of repairs) {
      console.log(
        `[reconcile] ${r.group}: ${r.fromModelId ?? '<null>'} → ${r.toModelId ?? '<null>'} (${r.reason})`
      )
    }
  }

  return repairs
}

/** Anzeigename für das Banner — auch für IDs, die nur noch in RETIRED_MODELS stehen. */
function modelLabel(id: string | null): string | null {
  if (id === null) return null
  return getModelById(id)?.label ?? RETIRED_MODELS.find((m) => m.id === id)?.label ?? id
}

function newReconcileEvent(repair: ReconcileRepair): ReconcileEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    group: repair.group,
    fromModelId: repair.fromModelId,
    toModelId: repair.toModelId,
    fromLabel: modelLabel(repair.fromModelId),
    toLabel: modelLabel(repair.toModelId),
    reason: repair.reason,
    status: 'pending'
  }
}

/**
 * Räumt aus dem Katalog entfernte Modelle (`RETIRED_MODELS`) auf: löscht die
 * Datei samt Download-/Update-Resten (`removeModelArtifacts` — kennt sonst
 * niemand mehr), den Installed-Version-Eintrag (No-op, wenn schon weg) und —
 * falls das Modell aktiv war — leert den Slot und meldet ein
 * `model-retired`-ReconcileEvent (Hinweispunkt der Seitenleiste → Banner in Einstellungen →
 * Modelle). Vorgemerkte Updates für die ID verwirft das Update-System selbst
 * (`selectBundle` überspringt ausgemusterte IDs).
 *
 * Einen Nachfolger setzt erst der Reconciler: in Pflichtgruppen ein
 * installiertes Modell (Standard zuerst), sonst lädt der Ersteinrichtungs-
 * Bildschirm den Standard (`getModelsToLoadOnFirstLaunch`) und der Reconciler
 * danach aktiviert ihn. In beiden Fällen ergänzt er dieses Event um den
 * Nachfolger statt ein zweites anzulegen. Optionale Gruppen bleiben leer — der
 * Nutzer lädt den Nachfolger selbst.
 *
 * Muss VOR `reconcileActiveModels()` laufen: der sähe sonst eine unbekannte
 * ID im Slot und meldete "nicht mehr gefunden". Idempotent — nach dem ersten
 * Lauf ist alles weg und jeder weitere Aufruf ein No-op. Löschfehler (z. B.
 * Rechte) werden geloggt; der Slot wird trotzdem geleert, weil der Katalog
 * die ID nicht mehr kennt.
 */
export function retireObsoleteModels(): void {
  const settings = getSettings()
  const events: ReconcileEvent[] = []
  let active = settings.get('activeModels')

  for (const retired of RETIRED_MODELS) {
    try {
      removeModelArtifacts(retired.id, retired.relativePath)
    } catch (err) {
      console.error(`[retire] ${retired.id}: Löschen fehlgeschlagen`, err)
    }
    deleteInstalledVersion(retired.id)

    // Ein ausgemustertes Modell ohne Slot (z. B. ein altes Suchmodell) braucht nur das Löschen
    if (!isSlotModelGroup(retired.group)) continue
    const slot = GROUP_TO_SETTINGS_KEY[retired.group]
    if (active[slot] !== retired.id) continue
    active = { ...active, [slot]: null }
    events.push(
      newReconcileEvent({
        group: retired.group,
        fromModelId: retired.id,
        toModelId: null,
        reason: 'model-retired'
      })
    )
  }

  if (events.length === 0) return
  settings.set('activeModels', active)
  // Kein Round-Trip-Collapse wie im Reconciler nötig: ein Retire wird nie
  // rückgängig gemacht, die ID kommt nicht in den Katalog zurück.
  settings.set('reconcileEvents', [...(settings.get('reconcileEvents') ?? []), ...events])
}

// ─── Reconcile event lifecycle ────────────────────────────────────────────────

export function getReconcileEvents(): ReconcileEvent[] {
  return getSettings().get('reconcileEvents') ?? []
}

/** Renderer hat Settings → Modelle gemountet — Banner gesehen, Hinweispunkt der Seitenleiste kann weg. */
export function markReconcileEventsSeen(): ReconcileEvent[] {
  const settings = getSettings()
  const events = settings.get('reconcileEvents') ?? []
  if (events.length === 0 || events.every((e) => e.status === 'seen')) return events
  const next: ReconcileEvent[] = events.map((e) => ({ ...e, status: 'seen' as const }))
  settings.set('reconcileEvents', next)
  return next
}

/** User klickte "Verstanden" — alle Events permanent löschen. */
export function dismissReconcileEvents(): void {
  getSettings().set('reconcileEvents', [])
}
