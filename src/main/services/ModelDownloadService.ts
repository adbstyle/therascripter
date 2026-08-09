import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { BrowserWindow } from 'electron'
import { getDataDir } from '../db/connection'
import { getSettings, type AppSettings } from './SettingsService'
import { deleteInstalledVersion, setInstalledVersion } from './InstalledVersionsStore'
import { downloadFile, verifyFileSha256, extractTarGz } from './DownloadService'
import type { ModelGroup } from '../../shared/validation/model-catalog-schemas'
import { MODEL_DEFINITIONS, type ModelDefinition } from '../../shared/model-catalog'
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

// Sentinel for "hash not yet synced from R2 manifest" — keeps the catalog entry in
// the source for IDE navigation + manifest extraction (publish-manifest.sh reads
// MODEL_DEFINITIONS directly), but hides the model from runtime accessors so the
// Settings UI doesn't list it and isModelInstalled returns false. Once the model
// is uploaded and the hash is synced via scripts/publish-manifest.sh, the entry
// becomes live automatically.
const PLACEHOLDER_SHA256 = '0'.repeat(64)

function isPublishable(m: ModelDefinition): boolean {
  return m.sha256 !== PLACEHOLDER_SHA256
}

const _placeholderEntries = MODEL_DEFINITIONS.filter((m) => !isPublishable(m))
if (_placeholderEntries.length > 0) {
  console.warn(
    `[ModelDownloadService] ${_placeholderEntries.length} catalog entries have placeholder sha256 ` +
      `and are filtered from runtime accessors: ${_placeholderEntries.map((m) => m.id).join(', ')}. ` +
      `Sync hashes from manifest.json after scripts/publish-manifest.sh.`
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
  const active = getSettings().get('activeModels')
  let id: string | null
  if (group === 'asr') id = active.transcription
  else if (group === 'diarization') id = active.diarization
  else if (group === 'ner') id = active.ner
  else if (group === 'summarization') id = active.summarization
  else throw new Error(`Keine aktive Modell-Konfiguration für Gruppe "${group}"`)

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
 *   1. aktives ASR-Modell (Transkription, User-wählbar)
 *   2. alle isRequired-Modelle in Definition-Reihenfolge
 *      (derzeit: pyannote-suite für Sprechererkennung, flair für Anonymisierung)
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

  const activeAsr = activeAsrId ? getModelById(activeAsrId) : null
  if (activeAsr && activeAsr.group === 'asr' && !seen.has(activeAsr.id)) {
    seen.add(activeAsr.id)
    out.push(activeAsr)
  }
  for (const m of getRequiredModels()) {
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
 */
export function checkRequiredAndActiveExist(
  activeAsrId: string | null,
  activeDiarId: string | null
): boolean {
  if (activeAsrId === null) return false
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId, activeDiarId)
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

export async function startModelDownload(): Promise<void> {
  if (abortSignal && !abortSignal.aborted) return // Already downloading

  abortSignal = { aborted: false }
  const modelsDir = getModelsDir()
  const overallTotal = getOverallModelSize()
  let overallDownloaded = 0

  for (const model of getModelsToLoad()) {
    const checkTarget = join(modelsDir, model.checkPath)

    // Skip already downloaded/extracted models
    if (existsSync(checkTarget)) {
      overallDownloaded += model.sizeBytes
      continue
    }

    if (abortSignal.aborted) {
      sendProgress({ state: 'error', error: 'Download abgebrochen', modelId: model.id })
      return
    }

    try {
      assertFinalSha256(model)
    } catch (err) {
      sendProgress({
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
        modelId: model.id
      })
      abortSignal = null
      return
    }

    // For archives: download to a temp .tar.gz file, then extract
    // For flat files: download directly to the target path
    const targetPath = model.archive
      ? join(modelsDir, `${model.id}.tar.gz`)
      : join(modelsDir, model.relativePath)

    const baseOverall = overallDownloaded

    const result = await downloadFile(
      model.url,
      targetPath,
      (progress) => {
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
      abortSignal
    )

    if (!result.success) {
      sendProgress({
        state: 'error',
        error: result.error ?? 'Download fehlgeschlagen',
        modelId: model.id
      })
      abortSignal = null
      return
    }

    // SHA-256 verification (skip if hash not configured). Bevorzugt den beim
    // Streamen mitberechneten Hash — erspart den zweiten Full-Read; Fallback
    // (Resume-Downloads) liest die Datei nochmal.
    if (model.sha256) {
      sendProgress({ state: 'verifying', modelId: model.id })
      const valid = result.sha256
        ? result.sha256 === model.sha256
        : await verifyFileSha256(targetPath, model.sha256)
      if (!valid) {
        try {
          unlinkSync(targetPath)
        } catch {
          /* non-fatal */
        }
        sendProgress({
          state: 'error',
          error: `SHA-256-Prüfung fehlgeschlagen für ${model.label}`,
          modelId: model.id
        })
        abortSignal = null
        return
      }
    }

    // Extract tar.gz archives
    if (model.archive) {
      sendProgress({ state: 'extracting', modelId: model.id })
      const extractDir = join(modelsDir, model.relativePath)
      mkdirSync(extractDir, { recursive: true })
      const extractResult = await extractTarGz(targetPath, extractDir)
      if (!extractResult.success) {
        try {
          unlinkSync(targetPath)
        } catch {
          /* non-fatal */
        }
        sendProgress({
          state: 'error',
          error: extractResult.error ?? 'Entpacken fehlgeschlagen',
          modelId: model.id
        })
        abortSignal = null
        return
      }
    }

    // Only record the install hash once `checkPath` is observable on disk —
    // a successful tar exit doesn't guarantee the inner file we use as the
    // installed-marker actually landed (malformed archive, disk-full mid-write).
    // Skipping the recordInstalledVersion call here lets `migrateInstalledVersions`
    // / lazy heal recover on the next manifest check rather than persisting a
    // hash for a half-installed model.
    if (existsSync(join(modelsDir, model.checkPath))) {
      recordInstalledVersion(model.id, model.sha256)
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
 * startModelDownload auf First-Launch und werden hier abgewiesen.
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

  abortSignal = { aborted: false }
  const modelsDir = getModelsDir()
  const checkTarget = join(modelsDir, def.checkPath)

  if (existsSync(checkTarget)) {
    sendProgress({ state: 'complete' })
    abortSignal = null
    return
  }

  try {
    assertFinalSha256(def)
  } catch (err) {
    abortSignal = null
    throw err
  }

  const targetPath = def.archive
    ? join(modelsDir, `${def.id}.tar.gz`)
    : join(modelsDir, def.relativePath)
  // Required-group dirs (asr/diarization/ner) are bootstrapped at startup by
  // initDatabase. Optional groups (summarization, …) are not — first
  // download for such a group lands in a parent that does not exist yet.
  // Mirroring the same defensive mkdirSync used in executeUpdates' atomic
  // swap path, the entry point for download owns the parent.
  mkdirSync(dirname(targetPath), { recursive: true })

  const result = await downloadFile(
    def.url,
    targetPath,
    (progress) => {
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
    abortSignal
  )

  // Error-Reporting läuft ausschliesslich via thrown Error → IPC-Rejection → Renderer-Toast.
  // Kein sendProgress({state:'error'}) hier, sonst würde der Renderer den Toast doppelt zeigen
  // (einmal via modelDownload:status-Subscription, einmal via IPC-Catch in ModelsSettings).
  if (!result.success) {
    abortSignal = null
    throw new Error(result.error ?? 'Download fehlgeschlagen')
  }

  sendProgress({ state: 'verifying', modelId: def.id })
  const valid = result.sha256
    ? result.sha256 === def.sha256
    : await verifyFileSha256(targetPath, def.sha256)
  if (!valid) {
    try {
      unlinkSync(targetPath)
    } catch {
      /* non-fatal */
    }
    abortSignal = null
    throw new Error(`SHA-256-Prüfung fehlgeschlagen für ${def.label}`)
  }

  if (def.archive) {
    sendProgress({ state: 'extracting', modelId: def.id })
    const extractDir = join(modelsDir, def.relativePath)
    mkdirSync(extractDir, { recursive: true })
    const extractResult = await extractTarGz(targetPath, extractDir)
    if (!extractResult.success) {
      try {
        unlinkSync(targetPath)
      } catch {
        /* non-fatal */
      }
      abortSignal = null
      throw new Error(extractResult.error ?? 'Entpacken fehlgeschlagen')
    }
  }

  // Disk-presence guard before recording — see startModelDownload for the
  // reasoning. A successful tar exit isn't a guarantee that `checkPath` is
  // populated.
  if (existsSync(join(modelsDir, def.checkPath))) {
    recordInstalledVersion(def.id, def.sha256)
    // Auto-activate optional models with empty slots. MUST run inside the
    // disk-presence guard, sonst würde setActiveModel mit "nicht installiert"
    // werfen, wenn checkPath nach erfolgreichem Download doch fehlt (z.B.
    // tar-Extract-Edge-Case).
    autoActivateAfterDownload(def.id)
  }
  sendProgress({ state: 'complete' })
  abortSignal = null
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

  const modelsDir = getModelsDir()
  const target = join(modelsDir, def.checkPath)
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }
  const archivePath = join(modelsDir, `${def.id}.tar.gz`)
  if (existsSync(archivePath)) {
    try {
      unlinkSync(archivePath)
    } catch {
      /* non-fatal */
    }
  }

  deleteInstalledVersion(id)

  // Optionale Gruppen: war das gelöschte Modell aktiv, Active-Slot räumen,
  // damit die UI nicht „Aktiv" auf etwas Nichtexistentem anzeigt. Erlaubt durch
  // OPTIONAL_GROUPS-Whitelist — Pflichtgruppen sind durch isRequired+ASR-Guard
  // bereits oben geschützt.
  if (def.group && OPTIONAL_GROUPS.has(def.group)) {
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
const GROUP_TO_SETTINGS_KEY: Record<ModelGroup, keyof AppSettings['activeModels']> = {
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
export function setActiveModel(group: ModelGroup, id: string): void {
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
const OPTIONAL_GROUPS: ReadonlySet<ModelGroup> = new Set(['summarization'])

export function clearActiveModel(group: ModelGroup): void {
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
  if (!OPTIONAL_GROUPS.has(group)) return
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
const REQUIRED_GROUPS_FOR_RECONCILE: ReadonlySet<ModelGroup> = new Set([
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
export function defaultActiveModelFor(group: ModelGroup): string | null {
  if (OPTIONAL_GROUPS.has(group)) return null
  return REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
}

function pickInstalledForGroup(group: ModelGroup): string | null {
  const preferred = REQUIRED_GROUP_DEFAULTS[group as 'asr' | 'diarization' | 'ner']
  if (preferred && isModelInstalled(preferred)) return preferred
  for (const m of getModelsByGroup(group)) {
    if (isModelInstalled(m.id)) return m.id
  }
  return null
}

export interface ReconcileRepair {
  group: ModelGroup
  fromModelId: string | null
  toModelId: string | null
  reason: ReconcileReason
}

/**
 * Bootstrap reconciler — läuft einmal beim App-Start, NACH `initSettings()`
 * und VOR `createWindow()`. Geht jede Modell-Gruppe durch und stellt das
 * Invariant sicher:
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
 * BottomNav und das Banner in Settings → Modelle treibt.
 *
 * Performance: nur `existsSync`-Calls (≤ Katalog-Größe, derzeit 6), kein I/O
 * darüber hinaus. Crash-sicher per design — Disk ist Source of Truth,
 * electron-store ist Cache; ein Crash mitten im Write heilt sich beim nächsten
 * Bootstrap.
 */
export function reconcileActiveModels(): ReadonlyArray<ReconcileRepair> {
  const settings = getSettings()
  if (settings.get('modelsDownloaded') !== true) return []

  const groups: readonly ModelGroup[] = ['asr', 'diarization', 'ner', 'summarization']
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
      events = [
        ...events,
        {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          group: r.group,
          fromModelId: r.fromModelId,
          toModelId: r.toModelId,
          reason: r.reason,
          status: 'pending'
        }
      ]
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

// ─── Reconcile event lifecycle ────────────────────────────────────────────────

export function getReconcileEvents(): ReconcileEvent[] {
  return getSettings().get('reconcileEvents') ?? []
}

/** Renderer hat Settings → Modelle gemountet — Banner gesehen, BottomNav-Dot kann weg. */
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
