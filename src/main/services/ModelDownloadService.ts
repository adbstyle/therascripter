import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { getDataDir } from '../db/connection'
import { getSettings, type AppSettings } from './SettingsService'
import { downloadFile, verifyFileSha256, extractTarGz } from './DownloadService'
import type { ModelGroup } from '../../shared/validation/model-catalog-schemas'
import { MODEL_DEFINITIONS, type ModelDefinition } from '../../shared/model-catalog'

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

/** Liefert die aktuell aktive Model-ID für eine Gruppe aus den Settings. */
export function getActiveModelId(group: ModelGroup): string {
  const active = getSettings().get('activeModels')
  if (group === 'asr') return active.transcription
  if (group === 'diarization') return active.diarization
  if (group === 'ner') return active.ner
  if (group === 'summarization') return active.summarization
  throw new Error(`Keine aktive Modell-Konfiguration für Gruppe "${group}"`)
}

/** Liefert den absoluten Pfad zum aktiven Modell einer Gruppe (für Subprozess-Aufrufe). */
export function getActiveModelPath(group: ModelGroup): string {
  const id = getActiveModelId(group)
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Aktive Modell-ID "${id}" für Gruppe "${group}" nicht im Katalog gefunden`)
  }
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
  activeAsrId: string,
  _activeDiarId?: string
): ModelDefinition[] {
  const seen = new Set<string>()
  const out: ModelDefinition[] = []

  const activeAsr = getModelById(activeAsrId)
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
 */
export function checkRequiredAndActiveExist(
  activeAsrId: string,
  activeDiarId: string
): boolean {
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId, activeDiarId)
  return toCheck.every((m) => existsSync(join(modelsDir, m.checkPath)))
}

/** Backward-Compat-Alias. */
export function checkRequiredAndActiveAsrExist(activeAsrId: string): boolean {
  const activeDiar = getSettings().get('activeModels').diarization
  return checkRequiredAndActiveExist(activeAsrId, activeDiar)
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

export function getAlreadyDownloadedBytes(): number {
  const modelsDir = getModelsDir()
  let total = 0
  for (const model of getModelsToLoad()) {
    const checkTarget = join(modelsDir, model.checkPath)
    if (existsSync(checkTarget)) {
      total += model.sizeBytes
    } else if (!model.archive) {
      const partialPath = join(modelsDir, model.relativePath) + '.partial'
      if (existsSync(partialPath)) {
        total += statSync(partialPath).size
      }
    }
  }
  return total
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

    // SHA-256 verification (skip if hash not configured)
    if (model.sha256) {
      sendProgress({ state: 'verifying', modelId: model.id })
      const valid = await verifyFileSha256(targetPath, model.sha256)
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

    overallDownloaded += model.sizeBytes
  }

  // All models downloaded successfully
  getSettings().set('modelsDownloaded', true)
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
  const valid = await verifyFileSha256(targetPath, def.sha256)
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

  const installed = { ...settings.get('installedModelVersions') }
  delete installed[id]
  settings.set('installedModelVersions', installed)

  // Optionale Gruppen: war das gelöschte Modell aktiv, Active-Slot räumen,
  // damit die UI nicht „Aktiv" auf etwas Nichtexistentem anzeigt. Erlaubt durch
  // OPTIONAL_GROUPS-Whitelist — Pflichtgruppen sind durch isRequired+ASR-Guard
  // bereits oben geschützt.
  if (def.group && OPTIONAL_GROUPS.has(def.group)) {
    const slot = GROUP_TO_SETTINGS_KEY[def.group]
    if (active[slot] === id) {
      settings.set('activeModels', { ...settings.get('activeModels'), [slot]: '' })
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
  settings.set('activeModels', { ...current, [GROUP_TO_SETTINGS_KEY[group]]: '' })
}

/** Backward-Compat-Alias. */
export function setActiveAsrModel(id: string): void {
  setActiveModel('asr', id)
}
