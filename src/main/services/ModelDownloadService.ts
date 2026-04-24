import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { getDataDir } from '../db/connection'
import { getSettings } from './SettingsService'
import { downloadFile, verifyFileSha256, extractTarGz } from './DownloadService'

const R2_CDN = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev'

export type ModelGroup = 'asr' | 'diarization' | 'ner'

export interface ModelDefinition {
  id: string
  label: string
  url: string
  sizeBytes: number
  sha256: string
  // For flat files: relative path to the final file (e.g., 'asr/ggml-large-v3-turbo-q5_0.bin')
  // For archives: relative path of the extraction directory (e.g., 'diarization')
  relativePath: string
  // If true, download is a tar.gz that needs extraction into relativePath
  archive?: boolean
  // Path to check for existence (relative to modelsDir). Used by checkModelsExist().
  checkPath: string
  group?: ModelGroup
  isRequired?: boolean
  // ASR-only UI metadata
  description?: string
  languages?: string[]
  accuracyScore?: number
  speedScore?: number
  hfIdentifier?: string
}

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

// Model definitions — downloads from Cloudflare R2 CDN
const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper Large V3 Turbo (Multilingual)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    group: 'asr',
    isRequired: false,
    description:
      'Unterstützt alle Sprachen (Deutsch, Englisch, Französisch, Italienisch, …). Empfohlen als Standardmodell oder wenn Sitzungen mehrsprachig geführt werden.',
    languages: ['multi'],
    accuracyScore: 0.8,
    speedScore: 0.9
  },
  {
    id: 'whisper-large-v3-turbo-german',
    label: 'Whisper Large V3 Turbo (German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-german-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-german-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-german-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '15e92e3db0993c52fffa781513eec9253475331c1be808f8fb409285c9d9d030',
    group: 'asr',
    isRequired: false,
    description:
      'Auf Hochdeutsch optimiert (Basis: primeline/whisper-large-v3-turbo-german). Präziser bei Standarddeutsch als das multilinguale Modell. Nicht geeignet für starke Schweizerdeutsch-Mundart oder andere Sprachen.',
    languages: ['de'],
    accuracyScore: 0.87,
    speedScore: 0.9
  },
  {
    id: 'whisper-large-v3-turbo-swiss',
    label: 'Whisper Large V3 Turbo (Swiss-German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-swiss-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '2d56e773724a247360067b527417842b81d25ff891fed014341a6844f15ea612',
    group: 'asr',
    isRequired: false,
    description:
      'Spezialisiert auf starke Schweizerdeutsch-Dialekte (Basis: Flurin17/whisper-large-v3-turbo-swiss-german). Merklich präzisere Transkription bei ausgeprägter Mundart. Nicht geeignet für andere Sprachen.',
    languages: ['de-CH', 'de'],
    accuracyScore: 0.9,
    speedScore: 0.85
  },
  {
    id: 'pyannote-community-1',
    label: 'Sprechererkennung (pyannote-community-1)',
    url: `${R2_CDN}/pyannote-models.tar.gz`,
    relativePath: 'diarization',
    checkPath: 'diarization/models--pyannote--speaker-diarization-3.1',
    sizeBytes: 30_461_603,
    sha256: 'b42e8aee7cf5eb330f4d5519216f9035dc1defad871097977fa9cecc11edb570',
    archive: true,
    group: 'diarization',
    isRequired: true
  },
  {
    id: 'flair-ner-german-large',
    label: 'Anonymisierung (flair-ner-german-large)',
    url: `${R2_CDN}/flair-ner-german-large.tar.gz`,
    relativePath: 'ner',
    checkPath: 'ner/models/ner-german-large',
    sizeBytes: 1_741_705_466,
    sha256: 'a34f6315659a34991930dae5d7a2bc2f3ee24ff6eb70dcd4d41e3aca7a5253e6',
    archive: true,
    group: 'ner',
    isRequired: true
  }
]

let abortSignal: { aborted: boolean } | null = null

export function getModelDefinitions(): ModelDefinition[] {
  return MODEL_DEFINITIONS
}

export function getAsrModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.group === 'asr')
}

export function getRequiredModels(): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter((m) => m.isRequired === true)
}

export function getModelById(id: string): ModelDefinition | null {
  return MODEL_DEFINITIONS.find((m) => m.id === id) ?? null
}

/**
 * Modelle, die auf First-Launch heruntergeladen werden müssen:
 * alle required + das aktive ASR-Modell (falls gültig).
 */
export function getModelsToLoadOnFirstLaunch(activeAsrId: string): ModelDefinition[] {
  const required = getRequiredModels()
  const active = getModelById(activeAsrId)
  if (active && active.group === 'asr') {
    return [...required, active].filter(
      (m, i, arr) => arr.findIndex((x) => x.id === m.id) === i
    )
  }
  return required
}

/**
 * Prüft, ob die Minimal-Menge (required + aktives ASR) installiert ist.
 * Ersatz für checkModelsExist(), das alle Modelle erwartete.
 */
export function checkRequiredAndActiveAsrExist(activeAsrId: string): boolean {
  const modelsDir = getModelsDir()
  const toCheck = getModelsToLoadOnFirstLaunch(activeAsrId)
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

export function checkModelsExist(): boolean {
  const activeAsrId = getSettings().get('activeModels').transcription
  return checkRequiredAndActiveAsrExist(activeAsrId)
}

export function getModelsToLoad(): ModelDefinition[] {
  const activeAsrId = getSettings().get('activeModels').transcription
  return getModelsToLoadOnFirstLaunch(activeAsrId)
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
 * Lädt ein einziges ASR-Modell herunter (nicht für Pflicht-Modelle gedacht —
 * die laufen via startModelDownload auf First-Launch).
 *
 * Sendet denselben `modelDownload:status`-Channel wie startModelDownload,
 * damit die bestehende UI-Progress-Anzeige wiederverwendbar bleibt.
 */
export async function downloadSingleModel(id: string): Promise<void> {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Download: unbekanntes Modell "${id}"`)
  }
  if (def.group !== 'asr') {
    throw new Error(`Download: nur ASR-Modelle sind einzeln ladbar (id=${id})`)
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
 *   - Pflicht-Modelle (isRequired)
 *   - das aktuell aktive ASR-Modell
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
  const activeAsr = settings.get('activeModels').transcription
  if (activeAsr === id) {
    throw new Error(
      `Löschen: "${def.label}" ist aktuell aktiv. Zuerst anderes Modell aktivieren.`
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
}

/**
 * Wechselt das aktive ASR-Modell. Das Modell muss:
 *   - existieren (bekannte ID)
 *   - in der ASR-Gruppe liegen
 *   - auf Disk installiert sein
 */
export function setActiveAsrModel(id: string): void {
  const def = getModelById(id)
  if (!def) {
    throw new Error(`Aktivieren: unbekanntes Modell "${id}"`)
  }
  if (def.group !== 'asr') {
    throw new Error(`Aktivieren: "${def.label}" ist keine ASR-Engine`)
  }
  if (!isModelInstalled(id)) {
    throw new Error(`Aktivieren: "${def.label}" ist nicht installiert`)
  }
  const settings = getSettings()
  const current = settings.get('activeModels')
  settings.set('activeModels', { ...current, transcription: id })
}
