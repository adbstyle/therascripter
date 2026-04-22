import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
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
  // Optional in Task 1 to keep existing MODEL_DEFINITIONS valid; populated in Task 2.
  group?: ModelGroup
  // Default (undefined) = false. Required models download on first-launch, can't be deleted.
  isRequired?: boolean
  // ASR-only UI metadata
  description?: string
  languages?: string[]
  accuracyScore?: number
  speedScore?: number
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
      'Schnelles multilinguales Modell. Empfohlen wenn Sitzungen auch auf Hochdeutsch oder anderen Sprachen geführt werden, oder wenn Schweizerdeutsch im Dialekt eher moderat ausgeprägt ist.',
    languages: ['multi'],
    accuracyScore: 0.8,
    speedScore: 0.9
  },
  {
    id: 'whisper-large-v3-turbo-swiss',
    label: 'Whisper Large V3 Turbo (Swiss-German)',
    url: `${R2_CDN}/whisper-ggml-large-v3-turbo-swiss-q5_0.bin`,
    relativePath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    checkPath: 'asr/ggml-large-v3-turbo-swiss-q5_0.bin',
    sizeBytes: 0, // TBD: set after model conversion in scripts/convert-hf-whisper.sh
    sha256: 'PENDING_UPLOAD', // TBD: set after model conversion
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

export function getModelsDir(): string {
  return join(getDataDir(), 'models')
}

export function checkModelsExist(): boolean {
  const modelsDir = getModelsDir()
  return MODEL_DEFINITIONS.every((model) => {
    const checkTarget = join(modelsDir, model.checkPath)
    return existsSync(checkTarget)
  })
}

export function getOverallModelSize(): number {
  return MODEL_DEFINITIONS.reduce((sum, m) => sum + m.sizeBytes, 0)
}

export function getAlreadyDownloadedBytes(): number {
  const modelsDir = getModelsDir()
  let total = 0
  for (const model of MODEL_DEFINITIONS) {
    const checkTarget = join(modelsDir, model.checkPath)
    if (existsSync(checkTarget)) {
      // Model already extracted/downloaded — count full size
      total += model.sizeBytes
    } else if (!model.archive) {
      // Check for partial download of flat file
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

  for (const model of MODEL_DEFINITIONS) {
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
