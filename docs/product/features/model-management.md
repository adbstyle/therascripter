# Model Management

Therascript relies on three ML models that are downloaded on first launch and kept up to date via an R2-hosted manifest. App updates are surfaced separately through a non-blocking hint.

## First Launch Flow

On startup, `App.tsx` calls `modelDownload:status` (which runs `checkModelsExist()`) to determine whether all models are present. If any model is missing, `modelsReady` is `false` and the app renders `FirstLaunchScreen` instead of the main UI.

### Disk Space Check

Before the user can start the download, `FirstLaunchScreen` calls `modelDownload:checkDiskSpace`. The handler in `model-download-handlers.ts` uses `statfsSync` against `~/.therascript/` and enforces a **5 GB minimum** (`MINIMUM_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024`). If disk space is insufficient, the screen shows an error with available vs. required space and asks the user to free space and restart.

### Model Definitions

Three models are defined in `MODEL_DEFINITIONS` inside `ModelDownloadService.ts`:

| ID | Label | Download Size | Archive | Relative Path | Check Path |
|----|-------|--------------|---------|---------------|------------|
| `whisper-large-v3-turbo` | Spracherkennung (whisper-large-v3-turbo) | ~574 MB | No (flat `.bin`) | `asr/ggml-large-v3-turbo-q5_0.bin` | `asr/ggml-large-v3-turbo-q5_0.bin` |
| `pyannote-community-1` | Sprechererkennung (pyannote-community-1) | ~30 MB | Yes (`.tar.gz`) | `diarization` | `diarization/models--pyannote--speaker-diarization-3.1` |
| `flair-ner-german-large` | Anonymisierung (flair-ner-german-large) | ~1.74 GB | Yes (`.tar.gz`) | `ner` | `ner/models/ner-german-large` |

Total download: ~2.3 GB (combined archive sizes). All downloads come from the Cloudflare R2 CDN at `https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/`.

### Model Paths

All models live under `~/.therascript/models/`:

```
~/.therascript/models/
  asr/
    ggml-large-v3-turbo-q5_0.bin
  diarization/
    models--pyannote--speaker-diarization-3.1/
    ...
  ner/
    models/
      ner-german-large/
    ...
```

The `getModelsDir()` function returns `join(getDataDir(), 'models')` where `getDataDir()` resolves to `~/.therascript/`.

### Download Process

1. User clicks "Download starten" in `FirstLaunchScreen`.
2. `startModelDownload()` iterates over `MODEL_DEFINITIONS` sequentially.
3. For each model:
   - **Skip** if `checkPath` already exists (supports resume after partial downloads).
   - **Download** via `downloadFile()` from `DownloadService.ts` with progress callbacks. Flat files download directly to the target path; archives download to a temporary `.tar.gz` file.
   - **Verify** SHA-256 hash via `verifyFileSha256()`. On mismatch, the downloaded file is deleted and an error is shown.
   - **Extract** archives via `extractTarGz()` into the `relativePath` directory.
4. On completion, `modelsDownloaded` is set to `true` in electron-store and `FirstLaunchScreen` calls `onComplete`.

### Progress UI

`FirstLaunchScreen` displays:
- Per-model progress bars during download (percentage-based).
- Status text for extracting ("Wird entpackt...") and verifying ("Wird uberpruft...") phases.
- Overall progress bar showing `overallDownloaded / overallTotal` across all models.
- On error: error message with a "Erneut versuchen" (retry) button. A resume hint tells users the download continues on next launch.

Progress is pushed from the main process to the renderer via `modelDownload:status` IPC events using `BrowserWindow.webContents.send()`.

### Abort Handling

`ModelDownloadService` maintains an `abortSignal` object. If the app is closed during download, the next launch detects missing models and re-enters `FirstLaunchScreen`. Already-downloaded models are skipped (checked via `checkPath` existence). Partial flat-file downloads use a `.partial` suffix for tracking via `getAlreadyDownloadedBytes()`.

## R2 Manifest

### URL and Format

The manifest is fetched from:

```
https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json
```

Validated by `ManifestSchema` (Zod):

```typescript
{
  generatedAt: string,            // ISO timestamp
  latestAppVersion?: string,      // semver (e.g., "1.2.0") — optional
  models: [                       // at least 1 entry
    {
      id: string,                 // e.g., "whisper-large-v3-turbo"
      version: string,            // e.g., "1.1.0"
      label: string,              // human-readable name
      url: string,                // download URL
      sha256: string,             // 64-char hex hash
      sizeBytes: number           // positive integer
    }
  ]
}
```

### Fetch Details

- Uses Node.js `https.get` with a **15-second timeout**.
- Response body is capped at **100 KB** (guard against oversized responses).
- Errors are silently logged and ignored — the app continues without update information.

### Caching Strategy

There is no HTTP-level caching of the manifest itself. Instead:
- **App update status** is persisted in electron-store as `cachedAppUpdateStatus` so the sidebar hint appears immediately on next launch without a network call.
- At startup, `invalidateCachedAppUpdateIfNeeded()` clears the cache if the current app version is >= the cached `latestVersion` (user already updated).
- The manifest is fetched fresh on each check (startup + periodic timer in the main process).

## Model Update Flow

Model updates are checked by `UpdateCheckService.checkForUpdates()`, which is called by the main process at startup and periodically (24-hour timer).

### Detection

For each model in the manifest:
1. Path-traversal guards reject IDs containing `..` or `/`.
2. Compare the manifest's `sha256` against the locally stored `installedModelVersions[id].sha256`.
3. If the SHA differs (or the model has no recorded version), it is flagged as a pending update.
4. The model's `relativePath`, `archive` flag, and `checkPath` are looked up from the local `MODEL_DEFINITIONS`.

Available updates are pushed to the renderer via `modelUpdate:available`.

### Version Migration

On first run after the update system was added, `migrateInstalledVersions()` seeds `installedModelVersions` for any models that already exist on disk. These entries use `version: 'pre-update'` and an empty `sha256`, which ensures the next manifest check triggers an update.

### UpdateBanner (Non-blocking Notification)

When `useModelUpdates` receives updates via `modelUpdate:available`, `App.tsx` renders `UpdateBanner` at the top of the main UI. The banner shows:
- Number of models with updates and total download size.
- A "Jetzt neu starten" (restart now) button.

The banner is non-blocking — users can continue using the app normally.

### Restart Guard

When the user clicks restart, `modelUpdate:restart` is called. The handler **refuses** to restart if:
- A recording is active (`getActiveSessionId() !== null`).
- A processing task is running (`getTaskQueue().isProcessing()`).

If allowed, `triggerUpdateRestart()` persists the updates array to `pendingModelUpdates` in electron-store, then calls `app.relaunch()` + `app.quit()`.

### ModelUpdateScreen (Post-Restart Download)

After restart, `App.tsx` reads `pendingModelUpdates` from electron-store via `modelUpdate:getPending`. If updates are pending, the `ModelUpdateScreen` is rendered (full-screen, blocking the main UI).

User options:
- **"Update starten"** — calls `modelUpdate:startDownload`, which runs `executeUpdates()`.
- **"Uberspringen"** (skip) — calls `modelUpdate:clearPending`, clears `pendingModelUpdates` from settings, and proceeds to the main app. The update banner will reappear on the next manifest check.

### Atomic Download and Swap

`executeUpdates()` in `UpdateCheckService.ts` performs a safe update per model:

1. **Download** to `~/.therascript/models/.staging/<id>.tar.gz` (or `.bin`).
2. **SHA-256 verification** — on failure, the staged file is deleted and an error is sent.
3. **Extract** archives into `.staging/<id>/`.
4. **Backup** the current model by renaming it to `~/.therascript/models/.backup/<id>`.
5. **Atomic swap** via `renameSync()` from staging to the final path.
6. **Cleanup** the backup on success.
7. **Record** the new version in `installedModelVersions` with `version`, `sha256`, and `installedAt`.

After all updates complete, `pendingModelUpdates` is cleared and `.staging/` is removed.

### Crash Recovery

`cleanupIncompleteUpdates()` runs at startup to handle interrupted updates:
- Deletes any leftover `.staging/` directory.
- Scans `.backup/` — if a backup exists but the model's `checkPath` is missing (swap was interrupted), restores from backup. If the model exists (swap completed but cleanup was missed), removes the backup.

### Progress UI

`ModelUpdateScreen` mirrors the `FirstLaunchScreen` progress display:
- Per-model progress bars, extracting/verifying status text.
- Overall progress bar across all updates.
- On error: message with "Weiter" (continue) button. The error message reassures users that existing models are unchanged.

## App Update Flow

App updates are checked as part of the same `checkForUpdates()` call that checks model updates.

### Detection

1. The manifest's optional `latestAppVersion` field is compared against `app.getVersion()` using `isNewerVersion()` (strict semver comparison without pre-release tags).
2. If a newer version exists, `AppUpdateStatus` is set to `{ available: true, latestVersion, checkedAt }`.
3. The status is persisted in electron-store as `cachedAppUpdateStatus` and pushed to the renderer via `appUpdate:status`.

### Sidebar Hint

When `appUpdateStatus.available` is `true`, the sidebar in `App.tsx` replaces the version number with a clickable "Update verfugbar" link (styled as primary color with a dot indicator). Clicking it calls `appUpdate:openReleasePage`, which opens the GitHub Releases page in the default browser:

```
https://github.com/adbstyle/therascripter/releases/latest
```

### About Page

The Settings view's About tab provides a manual "check for updates" button via `useAppUpdate().checkNow()`, which triggers a full `checkForUpdates()` call and updates the status.

### Cached Status Lifecycle

The `cachedAppUpdateStatus` electron-store key follows this lifecycle:
1. **Set** after each successful manifest fetch with `{ available, latestVersion, checkedAt }`.
2. **Read** on renderer mount by `useAppUpdate` via `appUpdate:getStatus` (no network needed).
3. **Cleared** at startup by `invalidateCachedAppUpdateIfNeeded()` if the user has installed the update (current version >= cached latest version).

## electron-store Keys

| Key | Type | Purpose |
|-----|------|---------|
| `modelsDownloaded` | `boolean` | Set to `true` after first-launch download completes |
| `installedModelVersions` | `Record<string, { version, sha256, installedAt }>` | Tracks installed model versions for update comparison |
| `pendingModelUpdates` | `PendingModelUpdate[] \| null` | Set before restart with updates to apply; cleared after download or skip |
| `cachedAppUpdateStatus` | `{ available, latestVersion, checkedAt } \| null` | Persisted app update status for immediate sidebar display |

## IPC Channels

### Model Download (First Launch)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `modelDownload:status` | handle | Returns `{ modelsReady, models[] }` |
| `modelDownload:checkDiskSpace` | handle | Returns `{ sufficient, availableBytes, requiredBytes }` |
| `modelDownload:start` | handle | Starts sequential model download |
| `modelDownload:status` (event) | send | Pushes `ModelDownloadStatus` progress to renderer |

### Model Updates

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `modelUpdate:check` | handle | Triggers manifest check, returns model updates |
| `modelUpdate:restart` | handle | Persists updates + relaunches app (guarded) |
| `modelUpdate:startDownload` | handle | Executes pending updates after restart |
| `modelUpdate:getPending` | handle | Returns pending updates from electron-store |
| `modelUpdate:clearPending` | handle | Clears pending updates (skip) |
| `modelUpdate:available` | send | Pushes available updates to renderer |
| `modelUpdate:downloadProgress` | send | Pushes download progress during update |
| `modelUpdate:downloadComplete` | send | Signals all updates finished |
| `modelUpdate:downloadError` | send | Sends error message to renderer |

### App Updates

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `appUpdate:getStatus` | handle | Returns cached `AppUpdateStatus` (no network) |
| `appUpdate:check` | handle | Triggers full manifest check (model + app) |
| `appUpdate:openReleasePage` | handle | Opens GitHub Releases in default browser |
| `appUpdate:status` | send | Pushes app update status to renderer |
