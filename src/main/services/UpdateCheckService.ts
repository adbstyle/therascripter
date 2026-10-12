import { app, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync } from 'fs'
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
import { UPDATE_SIGNING_KEYS, manifestSignaturePath } from '../../shared/update-keys'
import { verifyManifestSignature } from './ManifestSignature'
import { sendToRenderer } from '../utils/ipc-helpers'
import type { ModelDownloadStatus } from '../../shared/types/IpcApi'
import type { PendingModelUpdate, CheckResult } from '../../shared/types/ModelUpdate'
import { getAppUpdateService } from './app-update-deps'
import { getTaskQueue } from './TaskQueueService'
import { z } from 'zod'

type Manifest = z.infer<typeof ManifestSchema>

const MANIFEST_URL = 'https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json'

// ─── Manifest fetch ───────────────────────────────────────────────────────────

/** Lädt eine kleine Datei als Bytes (Manifest, Signatur — beide < 100 KB). */
function fetchSmallFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const request = httpsGet(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy()
        fail(new Error(`HTTP ${response.statusCode} für ${url}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 100_000) {
          response.destroy()
          fail(new Error(`${url}: zu gross`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks))
      })
      response.on('error', fail)
    })
    request.on('error', fail)
    request.on('timeout', () => {
      request.destroy()
      fail(new Error(`${url}: Timeout`))
    })
  })
}

/**
 * Lädt die Update-Beschreibung und prüft ihre Signatur (Issue #163/#164).
 * Die Signatur liegt unter signatures/<sha256 der Manifest-Bytes>.json — so
 * passt sie immer zu genau den Bytes, die diese App erhalten hat. Ohne gültige
 * Signatur eines vertrauenswürdigen Schlüssels gibt es weder App- noch
 * Modell-Updates: ein kompromittierter Download-Server kann nichts unterschieben.
 */
export async function fetchVerifiedManifest(
  fetchFile: (url: string) => Promise<Buffer> = fetchSmallFile
): Promise<Manifest> {
  const bytes = await fetchFile(MANIFEST_URL)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signatureUrl = MANIFEST_URL.replace(/manifest\.json$/, manifestSignaturePath(sha256))
  let signature: unknown
  try {
    signature = JSON.parse((await fetchFile(signatureUrl)).toString('utf8'))
  } catch (err) {
    throw new Error(
      `Signatur der Update-Beschreibung fehlt: ${err instanceof Error ? err.message : err}`
    )
  }
  if (!verifyManifestSignature(bytes, signature, UPDATE_SIGNING_KEYS)) {
    throw new Error('Signatur der Update-Beschreibung ungültig — Updates werden ignoriert')
  }
  return ManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
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

let checkRunning: Promise<CheckResult> | null = null

/**
 * Prüft Modell- und App-Updates. Gleichzeitige Aufrufe (Start, Intervall,
 * «Nach Updates suchen») teilen sich einen Lauf.
 */
export function checkForUpdates(): Promise<CheckResult> {
  checkRunning ??= runCheck().finally(() => {
    checkRunning = null
  })
  return checkRunning
}

async function runCheck(): Promise<CheckResult> {
  try {
    const manifest = await fetchVerifiedManifest()

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

    // ── App update (Issue #164) ──
    getAppUpdateService()?.handleManifest(manifest.app)

    return { modelUpdates }
  } catch (error) {
    // Non-blocking: update check failures are silently ignored
    console.log(`UpdateCheckService: Update-Check fehlgeschlagen (ignoriert): ${error}`)
    // Sonst stünde in Einstellungen → Updates «aktuell», obwohl nichts geprüft wurde
    getAppUpdateService()?.handleCheckFailed()
    return { modelUpdates: [] }
  }
}

// ─── triggerUpdateRestart ────────────────────────────────────────────────────

/**
 * Persists the pending updates and relaunches the app so the next boot picks
 * them up via `getPending()` and renders ModelUpdateScreen.
 *
 * Dev-mode shim (Issue #84 follow-up): in `npm run dev`, `app.relaunch()`
 * spawns a fresh electron pointed at `localhost:5173`, but the `app.quit()`
 * that follows kills electron-vite's parent process — the dev server dies
 * before the new electron can load anything, leaving a white window.
 *
 * In dev we instead reload the renderer in place. The renderer remounts,
 * its startup `getPending()` call sees the freshly-written
 * `pendingModelUpdates`, and ModelUpdateScreen appears — same observable
 * UX as the production restart, without trashing the dev server. Main-
 * process state (TaskQueue, etc.) is not actually reset, but for QA of
 * the update flow the renderer remount is what's being exercised.
 */
export function triggerUpdateRestart(updates: PendingModelUpdate[]): void {
  getSettings().set('pendingModelUpdates', updates)

  if (!app.isPackaged) {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    mainWindow?.webContents.reload()
    return
  }

  app.relaunch()
  app.quit()
}

// ─── executeUpdates ───────────────────────────────────────────────────────────

let modelUpdatesRunning = false

/** Laufen gerade Modell-Updates (ModelUpdateScreen)? Ein App-Update wartet dann (#164). */
export function isModelUpdateRunning(): boolean {
  return modelUpdatesRunning
}

export async function executeUpdates(): Promise<void> {
  modelUpdatesRunning = true
  try {
    await executeUpdatesInner()
  } finally {
    modelUpdatesRunning = false
  }
}

async function executeUpdatesInner(): Promise<void> {
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

  // Disk-Precheck: Download (staging) + Backup der alten Version brauchen
  // kurzzeitig ~2× die Update-Größe. Vorher lief der Download bis zum
  // ENOSPC-Fehler mitten im Swap.
  try {
    const stats = statfsSync(modelsDir)
    const availableBytes = stats.bavail * stats.bsize
    const requiredBytes = overallTotal * 2
    if (availableBytes < requiredBytes) {
      const requiredGb = (requiredBytes / 1024 ** 3).toFixed(1)
      sendToRenderer(
        'modelUpdate:downloadError',
        `Nicht genügend freier Speicherplatz für das Update (benötigt ca. ${requiredGb} GB). ` +
          'Bitte schaffen Sie Platz und versuchen Sie es erneut.'
      )
      return
    }
  } catch (err) {
    // Precheck ist best-effort — bei statfs-Fehlern normal fortfahren
    console.warn('[UpdateCheck] Disk-Precheck fehlgeschlagen:', err)
  }

  // Queue-Quiescence: nach dem Relaunch resumed die TaskQueue recovered
  // Tasks, während wir hier Modellfiles swappen — renameSync konnte das
  // ASR-Modell unter einem laufenden whisper-Prozess wegtauschen.
  // shutdown() abortet den laufenden Task (er geht zurück auf pending und
  // resumed nach dem Swap mit dem NEUEN Modell); finally startet die Queue
  // auf jedem Ausgang wieder.
  try {
    await getTaskQueue().shutdown(15_000)
  } catch {
    // TaskQueue ggf. nicht initialisiert (z. B. im ModelUpdateScreen-Boot)
  }

  try {
    await runUpdates(updates, stagingDir, backupDir, modelsDir, overallTotal)
  } finally {
    try {
      getTaskQueue().start()
    } catch {
      // TaskQueue ggf. nicht initialisiert
    }
  }
}

async function runUpdates(
  updates: PendingModelUpdate[],
  stagingDir: string,
  backupDir: string,
  modelsDir: string,
  overallTotal: number
): Promise<void> {
  const settings = getSettings()
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
    const valid = downloadResult.sha256
      ? downloadResult.sha256 === update.sha256
      : await verifyFileSha256(downloadTarget, update.sha256)
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
 *
 * Boot-phase invariant: this MUST run after `initSettings` has applied the
 * Story-D channel-tag migration. If we hit untagged keys in the raw record,
 * the channel-aware adapter would silently filter them out (treating the
 * channel view as empty) and write fresh `prod:`-prefixed sentinel rows
 * alongside the legacy untagged ones — producing duplicate entries. Bailing
 * loudly here surfaces the boot-order regression at the source rather than
 * a few releases later as a mysterious manifest mismatch.
 */
export function migrateInstalledVersions(): void {
  const raw = getSettings().get('installedModelVersions') ?? {}
  const untaggedKey = Object.keys(raw).find((k) => !k.includes(':'))
  if (untaggedKey !== undefined) {
    throw new Error(
      `migrateInstalledVersions called before initSettings: untagged key "${untaggedKey}" present. ` +
        'The Story-D channel-tag migration in initSettings must run first.'
    )
  }

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
