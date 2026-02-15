import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { getDataDir } from '../db/connection'
import { getSettings } from './SettingsService'
import { downloadFile, verifyFileSha256, cleanupPartial } from './DownloadService'

export interface ModelDefinition {
  id: string
  label: string
  url: string
  relativePath: string
  sizeBytes: number
  sha256: string
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
  | { state: 'verifying'; modelId: string }
  | { state: 'complete' }
  | { state: 'error'; error: string; modelId: string }

// Model definitions — these URLs point to HuggingFace model files
const MODEL_DEFINITIONS: ModelDefinition[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Spracherkennung (whisper-large-v3-turbo)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    relativePath: 'asr/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 1_700_000_000,
    sha256: '' // To be filled with actual hash
  },
  {
    id: 'pyannote-community-1',
    label: 'Sprechererkennung (pyannote-community-1)',
    url: 'https://huggingface.co/pyannote/speaker-diarization-3.1/resolve/main/pytorch_model.bin',
    relativePath: 'diarization/pytorch_model.bin',
    sizeBytes: 200_000_000,
    sha256: '' // To be filled with actual hash
  },
  {
    id: 'flair-ner-german-large',
    label: 'Anonymisierung (flair-ner-german-large)',
    url: 'https://huggingface.co/flair/ner-german-large/resolve/main/pytorch-model.bin',
    relativePath: 'ner/pytorch-model.bin',
    sizeBytes: 2_200_000_000,
    sha256: '' // To be filled with actual hash
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
    const targetPath = join(modelsDir, model.relativePath)
    return existsSync(targetPath)
  })
}

export function getOverallModelSize(): number {
  return MODEL_DEFINITIONS.reduce((sum, m) => sum + m.sizeBytes, 0)
}

export function getAlreadyDownloadedBytes(): number {
  const modelsDir = getModelsDir()
  let total = 0
  for (const model of MODEL_DEFINITIONS) {
    const targetPath = join(modelsDir, model.relativePath)
    if (existsSync(targetPath)) {
      total += statSync(targetPath).size
    } else {
      const partialPath = targetPath + '.partial'
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
    const targetPath = join(modelsDir, model.relativePath)

    // Skip already downloaded models
    if (existsSync(targetPath)) {
      overallDownloaded += model.sizeBytes
      continue
    }

    if (abortSignal.aborted) {
      sendProgress({ state: 'error', error: 'Download abgebrochen', modelId: model.id })
      return
    }

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
            overallPercent: Math.round(((baseOverall + progress.downloadedBytes) / overallTotal) * 100)
          }
        })
      },
      abortSignal
    )

    if (!result.success) {
      sendProgress({ state: 'error', error: result.error ?? 'Download fehlgeschlagen', modelId: model.id })
      abortSignal = null
      return
    }

    // SHA-256 verification (skip if hash not configured)
    if (model.sha256) {
      sendProgress({ state: 'verifying', modelId: model.id })
      const valid = await verifyFileSha256(targetPath, model.sha256)
      if (!valid) {
        cleanupPartial(targetPath)
        try {
          const { unlinkSync } = await import('fs')
          unlinkSync(targetPath)
        } catch {
          // Ignore
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
