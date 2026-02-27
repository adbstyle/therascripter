import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { get as httpsGet } from 'https'
import { getSettings } from './SettingsService'
import { getModelDefinitions, getModelsDir } from './ModelDownloadService'
import { downloadFile, verifyFileSha256, extractTarGz } from './DownloadService'
import {
  ManifestSchema,
  PendingModelUpdateSchema
} from '../../shared/validation/model-update-schemas'
import { sendToRenderer } from '../utils/ipc-helpers'
import type { ModelDownloadStatus } from '../../shared/types/IpcApi'
import type { PendingModelUpdate } from '../../shared/types/ModelUpdate'
import { z } from 'zod'

const MANIFEST_URL =
  'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json'

// ─── Manifest fetch ───────────────────────────────────────────────────────────

function fetchManifestJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = httpsGet(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy()
        settled = true
        reject(new Error(`Manifest HTTP ${response.statusCode}`))
        return
      }

      let data = ''
      response.on('data', (chunk: Buffer) => {
        data += chunk.toString()
        // Guard against huge responses (manifest should be < 10 KB)
        if (data.length > 100_000 && !settled) {
          settled = true
          response.destroy()
          reject(new Error('Manifest zu gross'))
        }
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error('Manifest: ungültiges JSON'))
        }
      })
      response.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })

    request.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    request.on('timeout', () => {
      request.destroy()
      if (!settled) {
        settled = true
        reject(new Error('Manifest: Timeout'))
      }
    })
  })
}

// ─── checkForUpdates ─────────────────────────────────────────────────────────

export async function checkForUpdates(): Promise<PendingModelUpdate[]> {
  try {
    const raw = await fetchManifestJson(MANIFEST_URL)
    const manifest = ManifestSchema.parse(raw)

    const settings = getSettings()
    const installedVersions = settings.get('installedModelVersions') ?? {}
    const definitions = getModelDefinitions()

    const updates: PendingModelUpdate[] = []

    for (const manifestModel of manifest.models) {
      // Path-traversal guard on id
      if (manifestModel.id.includes('..') || manifestModel.id.includes('/')) {
        console.warn(`ModelUpdateService: suspicious model id skipped: ${manifestModel.id}`)
        continue
      }

      const installed = installedVersions[manifestModel.id]
      if (installed && installed.sha256 === manifestModel.sha256) {
        continue // Already up to date
      }

      // Find structural info from local MODEL_DEFINITIONS
      const definition = definitions.find((d) => d.id === manifestModel.id)
      if (!definition) {
        console.warn(`ModelUpdateService: unknown model id in manifest: ${manifestModel.id}`)
        continue
      }

      // Path-traversal guard on relativePath
      if (definition.relativePath.includes('..')) {
        console.warn(
          `ModelUpdateService: suspicious relativePath skipped: ${definition.relativePath}`
        )
        continue
      }

      updates.push({
        id: manifestModel.id,
        version: manifestModel.version,
        label: manifestModel.label,
        url: manifestModel.url,
        sha256: manifestModel.sha256,
        sizeBytes: manifestModel.sizeBytes,
        relativePath: definition.relativePath,
        archive: definition.archive,
        checkPath: definition.checkPath
      })
    }

    if (updates.length > 0) {
      sendToRenderer('modelUpdate:available', updates)
    }

    return updates
  } catch (error) {
    // Non-blocking: update check failures are silently ignored
    console.log(`ModelUpdateService: Update-Check fehlgeschlagen (ignoriert): ${error}`)
    return []
  }
}

// ─── triggerUpdateRestart ────────────────────────────────────────────────────

export function triggerUpdateRestart(updates: PendingModelUpdate[]): void {
  getSettings().set('pendingModelUpdates', updates)
  app.relaunch()
  app.quit()
}

// ─── executeUpdates ───────────────────────────────────────────────────────────

export async function executeUpdates(): Promise<void> {
  const settings = getSettings()

  // Re-validate stored data before using it (guards against corruption or tampered settings)
  const rawUpdates = settings.get('pendingModelUpdates')
  const parseResult = z.array(PendingModelUpdateSchema).safeParse(rawUpdates)
  if (!parseResult.success || parseResult.data.length === 0) {
    settings.set('pendingModelUpdates', null)
    return
  }
  const updates = parseResult.data

  const modelsDir = getModelsDir()
  const stagingDir = join(modelsDir, '.staging')
  const backupDir = join(modelsDir, '.backup')
  mkdirSync(stagingDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })

  const overallTotal = updates.reduce((sum, u) => sum + u.sizeBytes, 0)
  let overallDownloaded = 0

  for (const update of updates) {
    const baseOverall = overallDownloaded

    // ── 1. Download ──
    const downloadTarget = update.archive
      ? join(stagingDir, `${update.id}.tar.gz`)
      : join(stagingDir, `${update.id}.bin`)

    sendToRenderer('modelUpdate:downloadProgress', {
      state: 'downloading',
      progress: {
        currentModel: update.id,
        currentModelLabel: update.label,
        currentModelProgress: 0,
        currentModelDownloaded: 0,
        currentModelTotal: update.sizeBytes,
        overallDownloaded: baseOverall,
        overallTotal,
        overallPercent: overallTotal > 0 ? Math.round((baseOverall / overallTotal) * 100) : 0
      }
    } satisfies ModelDownloadStatus)

    const downloadResult = await downloadFile(
      update.url,
      downloadTarget,
      (progress) => {
        sendToRenderer('modelUpdate:downloadProgress', {
          state: 'downloading',
          progress: {
            currentModel: update.id,
            currentModelLabel: update.label,
            currentModelProgress: progress.percent,
            currentModelDownloaded: progress.downloadedBytes,
            currentModelTotal: progress.totalBytes,
            overallDownloaded: baseOverall + progress.downloadedBytes,
            overallTotal,
            overallPercent:
              overallTotal > 0
                ? Math.round(((baseOverall + progress.downloadedBytes) / overallTotal) * 100)
                : 0
          }
        } satisfies ModelDownloadStatus)
      }
    )

    if (!downloadResult.success) {
      sendToRenderer('modelUpdate:downloadError', downloadResult.error ?? `Download fehlgeschlagen: ${update.label}`)
      return
    }

    // ── 2. SHA-256 verification ──
    sendToRenderer('modelUpdate:downloadProgress', { state: 'verifying', modelId: update.id } satisfies ModelDownloadStatus)
    const valid = await verifyFileSha256(downloadTarget, update.sha256)
    if (!valid) {
      try { rmSync(downloadTarget) } catch { /* non-fatal */ }
      sendToRenderer('modelUpdate:downloadError', `SHA-256-Prüfung fehlgeschlagen: ${update.label}`)
      return
    }

    // ── 3. Extract archive (if needed) ──
    let stagedPath: string
    if (update.archive) {
      sendToRenderer('modelUpdate:downloadProgress', { state: 'extracting', modelId: update.id } satisfies ModelDownloadStatus)
      stagedPath = join(stagingDir, update.id)
      mkdirSync(stagedPath, { recursive: true })
      const extractResult = await extractTarGz(downloadTarget, stagedPath)
      if (!extractResult.success) {
        try { rmSync(stagedPath, { recursive: true }) } catch { /* non-fatal */ }
        sendToRenderer('modelUpdate:downloadError', extractResult.error ?? `Entpacken fehlgeschlagen: ${update.label}`)
        return
      }
    } else {
      stagedPath = downloadTarget
    }

    // ── 4. Backup current model ──
    const finalPath = join(modelsDir, update.relativePath)
    const backupPath = join(backupDir, update.id)

    if (existsSync(finalPath)) {
      try {
        renameSync(finalPath, backupPath)
      } catch (err) {
        try { rmSync(stagedPath, { recursive: true }) } catch { /* non-fatal */ }
        sendToRenderer('modelUpdate:downloadError', `Backup fehlgeschlagen: ${update.label}: ${err}`)
        return
      }
    }

    // ── 5. Atomic swap: staging → final ──
    // Ensure parent directory exists (e.g. models/asr/)
    if (update.relativePath.includes('/')) {
      const parentDir = join(modelsDir, update.relativePath.split('/').slice(0, -1).join('/'))
      mkdirSync(parentDir, { recursive: true })
    }

    try {
      renameSync(stagedPath, finalPath)
    } catch (err) {
      // Rollback: restore backup
      if (existsSync(backupPath)) {
        try { renameSync(backupPath, finalPath) } catch { /* non-fatal */ }
      }
      sendToRenderer('modelUpdate:downloadError', `Swap fehlgeschlagen: ${update.label}: ${err}`)
      return
    }

    // ── 6. Cleanup backup ──
    if (existsSync(backupPath)) {
      try { rmSync(backupPath, { recursive: true }) } catch { /* non-fatal */ }
    }

    // ── 7. Record installed version ──
    const installedVersions = settings.get('installedModelVersions') ?? {}
    installedVersions[update.id] = {
      version: update.version,
      sha256: update.sha256,
      installedAt: new Date().toISOString()
    }
    settings.set('installedModelVersions', installedVersions)

    overallDownloaded += update.sizeBytes
  }

  // All updates done — clear pending and cleanup staging
  settings.set('pendingModelUpdates', null)
  try { rmSync(stagingDir, { recursive: true }) } catch { /* non-fatal */ }
  sendToRenderer('modelUpdate:downloadComplete')
}

// ─── cleanupIncompleteUpdates ────────────────────────────────────────────────

export function cleanupIncompleteUpdates(): void {
  const modelsDir = getModelsDir()
  const stagingDir = join(modelsDir, '.staging')
  const backupDir = join(modelsDir, '.backup')

  // Delete incomplete staging dir
  if (existsSync(stagingDir)) {
    try {
      rmSync(stagingDir, { recursive: true })
      console.log('ModelUpdateService: .staging/ bereinigt')
    } catch (err) {
      console.error('ModelUpdateService: .staging/ konnte nicht bereinigt werden:', err)
    }
  }

  // Recover from interrupted swaps: if backup exists but model is missing → restore
  if (!existsSync(backupDir)) return

  const definitions = getModelDefinitions()

  try {
    const backupEntries = readdirSync(backupDir)
    for (const entry of backupEntries) {
      const backupPath = join(backupDir, entry)
      const definition = definitions.find((d) => d.id === entry)
      if (!definition) continue

      const finalPath = join(modelsDir, definition.relativePath)
      const checkTarget = join(modelsDir, definition.checkPath)

      if (!existsSync(checkTarget)) {
        // Model is missing — restore from backup
        try {
          // Ensure parent dir for flat files
          if (definition.relativePath.includes('/')) {
            const parentDir = join(
              modelsDir,
              definition.relativePath.split('/').slice(0, -1).join('/')
            )
            mkdirSync(parentDir, { recursive: true })
          }
          renameSync(backupPath, finalPath)
          console.log(`ModelUpdateService: Backup wiederhergestellt: ${entry}`)
        } catch (err) {
          console.error(
            `ModelUpdateService: Backup-Wiederherstellung fehlgeschlagen: ${entry}:`,
            err
          )
        }
      } else {
        // Model exists — swap completed, cleanup missed backup
        try {
          rmSync(backupPath, { recursive: true })
        } catch { /* non-fatal */ }
      }
    }

    // Remove backupDir if now empty
    if (readdirSync(backupDir).length === 0) {
      rmSync(backupDir, { recursive: true })
    }
  } catch (err) {
    console.error('ModelUpdateService: .backup/ cleanup fehlgeschlagen:', err)
  }
}

// ─── migrateInstalledVersions ─────────────────────────────────────────────────

export function migrateInstalledVersions(): void {
  const settings = getSettings()
  const installedVersions = settings.get('installedModelVersions') ?? {}

  // Only migrate if no versions recorded yet
  if (Object.keys(installedVersions).length > 0) return

  const modelsDir = getModelsDir()
  const definitions = getModelDefinitions()
  const now = new Date().toISOString()
  let migrated = 0

  for (const def of definitions) {
    const checkTarget = join(modelsDir, def.checkPath)
    if (existsSync(checkTarget)) {
      installedVersions[def.id] = {
        version: 'pre-update',
        sha256: '', // Unknown — forces update on first manifest check
        installedAt: now
      }
      migrated++
    }
  }

  if (migrated > 0) {
    settings.set('installedModelVersions', installedVersions)
    console.log(`ModelUpdateService: ${migrated} bestehende Modelle migriert`)
  }
}
