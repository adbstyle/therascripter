import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { get as httpsGet } from 'https'
import { getSettings } from './SettingsService'
import { getModelDefinitions, getModelsDir, isModelInstalled } from './ModelDownloadService'
import { getInstalledVersions, setInstalledVersion } from './InstalledVersionsStore'
import { downloadFile, verifyFileSha256, extractTarGz } from './DownloadService'
import {
  ManifestSchema,
  PendingModelUpdateSchema
} from '../../shared/validation/model-update-schemas'
import { sendToRenderer } from '../utils/ipc-helpers'
import type { ModelDownloadStatus } from '../../shared/types/IpcApi'
import type { PendingModelUpdate, AppUpdateStatus, CheckResult } from '../../shared/types/ModelUpdate'
import { z } from 'zod'

const MANIFEST_URL = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json'

// ─── Version comparison ──────────────────────────────────────────────────────

/** Returns true if `latest` is strictly newer than `current` (semver without pre-release). */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.').map(Number)
    if (parts.length !== 3 || parts.some(isNaN)) return [0, 0, 0]
    return parts as [number, number, number]
  }
  const [cMaj, cMin, cPat] = parse(current)
  const [lMaj, lMin, lPat] = parse(latest)
  if (lMaj !== cMaj) return lMaj > cMaj
  if (lMin !== cMin) return lMin > cMin
  return lPat > cPat
}

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

// ─── Manifest dismissal ──────────────────────────────────────────────────────

/**
 * Issue #84 / Story F+G — stable key for "this exact manifest entry was
 * dismissed by the user". Combines model id and sha256 so that a new manifest
 * publishing a different hash for the same id is automatically eligible again,
 * without explicit cleanup.
 */
export function manifestEntryKey(id: string, sha256: string): string {
  return `${id}@${sha256}`
}

/** Append entries to the dismiss list, preserving order and dropping duplicates. */
export function dismissManifestVersions(entries: Array<{ id: string; sha256: string }>): void {
  const settings = getSettings()
  const raw = settings.get('dismissedManifestVersions')
  const existing = Array.isArray(raw) ? raw : []
  const seen = new Set(existing)
  for (const e of entries) {
    seen.add(manifestEntryKey(e.id, e.sha256))
  }
  settings.set('dismissedManifestVersions', Array.from(seen))
}

// ─── checkForUpdates ─────────────────────────────────────────────────────────

const NO_APP_UPDATE: AppUpdateStatus = { available: false, latestVersion: null, checkedAt: null }

export async function checkForUpdates(): Promise<CheckResult> {
  try {
    const raw = await fetchManifestJson(MANIFEST_URL)
    const manifest = ManifestSchema.parse(raw)

    const settings = getSettings()
    const installedVersions = getInstalledVersions()
    const dismissedRaw = settings.get('dismissedManifestVersions')
    const dismissed = new Set(Array.isArray(dismissedRaw) ? dismissedRaw : [])
    const definitions = getModelDefinitions()

    // ── Model update check ──
    const modelUpdates: PendingModelUpdate[] = []

    for (const manifestModel of manifest.models) {
      // Path-traversal guard on id
      if (manifestModel.id.includes('..') || manifestModel.id.includes('/')) {
        console.warn(`UpdateCheckService: suspicious model id skipped: ${manifestModel.id}`)
        continue
      }

      // Find structural info from local MODEL_DEFINITIONS
      const definition = definitions.find((d) => d.id === manifestModel.id)
      if (!definition) {
        console.warn(`UpdateCheckService: unknown model id in manifest: ${manifestModel.id}`)
        continue
      }

      // Nur Modelle updaten, die bereits installiert sind — optionale ASR-Alternativen
      // ohne Install werden nicht als "Update verfügbar" beworben.
      if (!isModelInstalled(manifestModel.id)) {
        continue
      }

      const installed = installedVersions[manifestModel.id]
      if (installed && installed.sha256 === manifestModel.sha256) {
        continue // Already up to date
      }

      // Issue #84 / Story F+G — user actively dismissed this exact manifest
      // entry (UpdateBanner dismiss or ModelUpdateScreen "Diese Version
      // überspringen"). Re-becomes eligible when the manifest publishes a new
      // sha256 for the same id.
      if (dismissed.has(manifestEntryKey(manifestModel.id, manifestModel.sha256))) {
        continue
      }

      // Lazy heal of the legacy '' sentinel from migrateInstalledVersions:
      // for non-archive models we can hash the file on disk and compare against
      // the manifest. If they match, the install is bit-identical to the
      // current manifest version — backfill the real hash and skip the update,
      // closing the upgrade-from-old-build false-positive (Issue #84 / Story B).
      // Archive models can't be hashed post-extract (the .tar.gz is gone), so
      // they fall through to the standard update path; one accepted update will
      // then write the real hash via executeUpdates and the issue resolves.
      if (installed && installed.sha256 === '' && !definition.archive) {
        const filePath = join(getModelsDir(), definition.relativePath)
        if (existsSync(filePath)) {
          const matches = await verifyFileSha256(filePath, manifestModel.sha256)
          if (matches) {
            const healed = { ...installed, sha256: manifestModel.sha256 }
            setInstalledVersion(manifestModel.id, healed)
            installedVersions[manifestModel.id] = healed
            continue
          }
        }
      }

      // Path-traversal guard on relativePath
      if (definition.relativePath.includes('..')) {
        console.warn(
          `UpdateCheckService: suspicious relativePath skipped: ${definition.relativePath}`
        )
        continue
      }

      modelUpdates.push({
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

    if (modelUpdates.length > 0) {
      sendToRenderer('modelUpdate:available', modelUpdates)
    }

    // ── App update check ──
    const currentVersion = app.getVersion()
    const latestVersion = manifest.latestAppVersion ?? null
    const available =
      latestVersion !== null && isNewerVersion(currentVersion, latestVersion)
    const checkedAt = new Date().toISOString()

    const appUpdate: AppUpdateStatus = { available, latestVersion, checkedAt }

    // Persist for offline reads via appUpdate:getStatus
    settings.set('cachedAppUpdateStatus', appUpdate)

    sendToRenderer('appUpdate:status', appUpdate)

    return { modelUpdates, appUpdate }
  } catch (error) {
    // Non-blocking: update check failures are silently ignored
    console.log(`UpdateCheckService: Update-Check fehlgeschlagen (ignoriert): ${error}`)
    return { modelUpdates: [], appUpdate: NO_APP_UPDATE }
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

    const downloadResult = await downloadFile(update.url, downloadTarget, (progress) => {
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
    })

    if (!downloadResult.success) {
      sendToRenderer(
        'modelUpdate:downloadError',
        downloadResult.error ?? `Download fehlgeschlagen: ${update.label}`
      )
      return
    }

    // ── 2. SHA-256 verification ──
    sendToRenderer('modelUpdate:downloadProgress', {
      state: 'verifying',
      modelId: update.id
    } satisfies ModelDownloadStatus)
    const valid = await verifyFileSha256(downloadTarget, update.sha256)
    if (!valid) {
      try {
        rmSync(downloadTarget)
      } catch {
        /* non-fatal */
      }
      sendToRenderer('modelUpdate:downloadError', `SHA-256-Prüfung fehlgeschlagen: ${update.label}`)
      return
    }

    // ── 3. Extract archive (if needed) ──
    let stagedPath: string
    if (update.archive) {
      sendToRenderer('modelUpdate:downloadProgress', {
        state: 'extracting',
        modelId: update.id
      } satisfies ModelDownloadStatus)
      stagedPath = join(stagingDir, update.id)
      mkdirSync(stagedPath, { recursive: true })
      const extractResult = await extractTarGz(downloadTarget, stagedPath)
      if (!extractResult.success) {
        try {
          rmSync(stagedPath, { recursive: true })
        } catch {
          /* non-fatal */
        }
        sendToRenderer(
          'modelUpdate:downloadError',
          extractResult.error ?? `Entpacken fehlgeschlagen: ${update.label}`
        )
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
        try {
          rmSync(stagedPath, { recursive: true })
        } catch {
          /* non-fatal */
        }
        sendToRenderer(
          'modelUpdate:downloadError',
          `Backup fehlgeschlagen: ${update.label}: ${err}`
        )
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
        try {
          renameSync(backupPath, finalPath)
        } catch {
          /* non-fatal */
        }
      }
      sendToRenderer('modelUpdate:downloadError', `Swap fehlgeschlagen: ${update.label}: ${err}`)
      return
    }

    // ── 6. Cleanup backup ──
    if (existsSync(backupPath)) {
      try {
        rmSync(backupPath, { recursive: true })
      } catch {
        /* non-fatal */
      }
    }

    // ── 7. Record installed version ──
    setInstalledVersion(update.id, {
      version: update.version,
      sha256: update.sha256,
      installedAt: new Date().toISOString()
    })

    overallDownloaded += update.sizeBytes
  }

  // All updates done — clear pending and cleanup staging
  settings.set('pendingModelUpdates', null)
  try {
    rmSync(stagingDir, { recursive: true })
  } catch {
    /* non-fatal */
  }
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
      console.log('UpdateCheckService: .staging/ bereinigt')
    } catch (err) {
      console.error('UpdateCheckService: .staging/ konnte nicht bereinigt werden:', err)
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
          console.log(`UpdateCheckService: Backup wiederhergestellt: ${entry}`)
        } catch (err) {
          console.error(
            `UpdateCheckService: Backup-Wiederherstellung fehlgeschlagen: ${entry}:`,
            err
          )
        }
      } else {
        // Model exists — swap completed, cleanup missed backup
        try {
          rmSync(backupPath, { recursive: true })
        } catch {
          /* non-fatal */
        }
      }
    }

    // Remove backupDir if now empty
    if (readdirSync(backupDir).length === 0) {
      rmSync(backupDir, { recursive: true })
    }
  } catch (err) {
    console.error('UpdateCheckService: .backup/ cleanup fehlgeschlagen:', err)
  }
}

// ─── migrateInstalledVersions ─────────────────────────────────────────────────

/**
 * Backfills an empty `installedModelVersions` view for the active channel
 * with `'pre-update'` sentinel rows whenever a model file exists on disk.
 *
 * Story D — the per-channel guard means a freshly switched channel sees
 * its own (initially empty) view, even when other channels already have
 * entries; the disk files are reused in-place by the new channel.
 */
export function migrateInstalledVersions(): void {
  const installedVersions = getInstalledVersions()
  if (Object.keys(installedVersions).length > 0) return

  const modelsDir = getModelsDir()
  const definitions = getModelDefinitions()
  const now = new Date().toISOString()
  let migrated = 0

  for (const def of definitions) {
    const checkTarget = join(modelsDir, def.checkPath)
    if (existsSync(checkTarget)) {
      setInstalledVersion(def.id, {
        version: 'pre-update',
        sha256: '', // Unknown — forces update on first manifest check
        installedAt: now
      })
      migrated++
    }
  }

  if (migrated > 0) {
    console.log(`UpdateCheckService: ${migrated} bestehende Modelle migriert`)
  }
}

// ─── invalidateCachedAppUpdate ───────────────────────────────────────────────

/**
 * Called at startup: if the user installed the update (current version >= cached
 * latestVersion), clear the stale "update available" cache. If the user has NOT
 * upgraded, preserve the cache so the sidebar hint appears immediately.
 */
export function invalidateCachedAppUpdateIfNeeded(): void {
  const settings = getSettings()
  const cached = settings.get('cachedAppUpdateStatus')
  if (!cached || !cached.available) return

  const currentVersion = app.getVersion()
  if (cached.latestVersion && !isNewerVersion(currentVersion, cached.latestVersion)) {
    // User installed the update (or a newer version) — clear stale cache
    settings.set('cachedAppUpdateStatus', null)
  }
  // Otherwise: update still pending, keep the cache so sidebar shows hint immediately
}
