# Model Management

Therascript relies on three ML models that are downloaded on first launch and kept up to date via an R2-hosted manifest. App updates are surfaced separately through a non-blocking hint.

Since v0.5 the ASR model (transcription) is **user-selectable** from a catalog — the default is the multilingual Turbo model; a High-German fine-tune can optionally be installed. A Swiss-German fine-tune was offered until v0.10.0 and retired for its non-commercial license (CC BY-NC 4.0, #185); Swiss German is transcribed by the default model, which normalizes it to High German (`-l de`). See [ASR Model Catalog](#asr-model-catalog) below.

## First Launch Flow

On startup, `App.tsx` calls `modelDownload:status` (which runs `checkModelsExist()`) to determine whether all models are present. If any model is missing, `modelsReady` is `false` and the app renders `FirstLaunchScreen` instead of the main UI.

### Disk Space Check

Before the user can start the download, `FirstLaunchScreen` calls `modelDownload:checkDiskSpace`. The handler in `model-download-handlers.ts` uses `statfsSync` against `~/.therascript/` and enforces a **5 GB minimum** (`MINIMUM_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024`). If disk space is insufficient, the screen shows an error with available vs. required space and asks the user to free space and restart.

### Model Definitions

The required models are defined in `MODEL_DEFINITIONS` in `src/shared/model-catalog.ts` (single source of truth for URL, size and SHA-256):

| ID | Label | Download Size | Archive | Relative Path | Check Path |
|----|-------|--------------|---------|---------------|------------|
| `whisper-large-v3-turbo` | Spracherkennung (whisper-large-v3-turbo) | ~574 MB | No (flat `.bin`) | `asr/ggml-large-v3-turbo-q5_0.bin` | `asr/ggml-large-v3-turbo-q5_0.bin` |
| `pyannote-suite` | Sprechererkennung (pyannote 3.1 + community-1) | ~61 MB | Yes (`.tar.gz`) | `diarization` | see catalog |
| `flair-ner-german-large` | Anonymisierung (flair-ner-german-large) | ~1.04 GB (v3, fp16) | Yes (`.tar.gz`) | `ner` | `ner/hf/hub/models--xlm-roberta-large` |

The NER check path deliberately points at the **v2-only** `hf/` tokenizer subtree (not the model payload): v1 installs (≤ 0.8.5, without `hf/`) read as "not installed", so the first-launch gate re-downloads the current tarball, which tar-merges over the existing `ner/`. The bootstrap reconciler shares this definition and clears the `ner` slot on such installs; `startModelDownload()` re-runs the reconciler after a successful download to re-promote the slot in the same session, and inverse repairs (X → null → X) collapse the pending reconcile event so the upgrade shows no "Modell entfernt" banner.

Total download: ~1.7 GB (combined archive sizes). v2 installs keep counting as installed (same check path) and get v3 offered as a dismissible model update via the manifest. All downloads come from the Cloudflare R2 CDN at `https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/`.

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
    hf/
      hub/
        models--xlm-roberta-large/
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

Parsed by `parseManifest()` (`src/shared/validation/model-update-schemas.ts`) after the signature check. Entries are validated one by one — an invalid model or app entry is dropped and logged, the rest of the manifest stays usable (a new model group must not stop all updates):

```typescript
{
  generatedAt: string,            // ISO timestamp
  latestAppVersion?: string,      // semver
  app?: { version, url, sha256, sizeBytes },   // DMG of the newest release (#163)
  models: [                       // at least 1 entry
    {
      id: string,                 // a-z, 0-9, '-', '.'
      version: string,            // informational date, e.g. "2026-10-12"
      label: string,
      url: string,                // https only (#167 AK 7)
      sha256: string,             // 64-char hex — the only update trigger
      sizeBytes: number,
      minAppVersion?: string,     // first app version the artifact fits (#163)
      // Layout (#167) — lets an older app stage a model its own catalog does not know:
      relativePath?: string,      // below models/, safe segments only (no '..', no hidden dirs)
      checkPath?: string,         // equals or lies inside relativePath
      archive?: boolean,          // tar.gz into its own top-level folder
      group?: string,             // free text on purpose
      required?: boolean
    }
  ]
}
```

`buildManifest()` (`src/shared/update-manifest.ts`, called by `scripts/manifest-from-catalog.ts`) always writes the layout from the release's catalog. Older apps (≤ v0.9.x) strip the layout fields (zod drops unknown keys) and keep working.

### Fetch Details

- Uses Node.js `https.get` with a **15-second timeout**.
- Response body is capped at **100 KB** (guard against oversized responses).
- Errors are logged and otherwise ignored — the app continues without update information. `AppUpdateService.handleCheckFailed()` records the failure so Settings → Updates says «Die Suche nach Updates ist nicht gelungen» instead of «aktuell» (also for an invalid signature); «aktuell» appears only after a successful check (`checkedAt`).

### Caching Strategy

The manifest is fetched fresh on each check (start, every 4 hours, «Nach Updates suchen»). What survives a restart is the selected update itself (`appUpdate` setting, see below), not the manifest.

## Update Flow — App and Models as One (Issues #164, #165, #167)

The app updates itself without Developer ID (ADR-009). App and model updates are **one operation with a single restart** (#167): `AppUpdateService` (`src/main/services/AppUpdateService.ts`, platform access injected via `app-update-deps.ts`) owns the state; the renderer only displays it. There is no separate model-update flow any more (the former `UpdateBanner`, `ModelUpdateScreen`, `pendingModelUpdates`, «Diese Version überspringen» and the `modelUpdate:*` IPC channels are gone).

### Signed manifest

`checkForUpdates()` fetches `manifest.json` as raw bytes, then `signatures/<sha256 of the bytes>.json`, and verifies the Ed25519 signature against `UPDATE_SIGNING_KEYS` (`fetchVerifiedManifest`). Without a valid signature there are **no** app or model updates. Checks run at start, every 4 hours and on «Nach Updates suchen» (single-flight). Before handing over, the check heals legacy `installedModelVersions` entries with an unknown sha256 (`''`, from `migrateInstalledVersions`) by hashing flat model files. The whole manifest goes to `AppUpdateService.handleManifest()`.

### What belongs to an update

`selectBundle()` (`src/shared/update-bundle.ts`, pure) computes the update from the manifest and the local state:

- **App:** the manifest's `app` if strictly newer **and** the app can replace itself. Otherwise the app part is dropped and shown as «von Hand» (`manualVersion`, guide button) — model parts still install.
- **Model updates:** every manifest model whose `checkPath` exists on disk and whose installed sha256 differs (legacy `''` counts as different). Optional models that are not installed are never offered.
- **New required models (AK 4):** a `required` model that is not on disk comes along **only together with a new app** — the new version would otherwise start into the first-launch screen.
- **Compatibility (AK 6):** a model with `minAppVersion` above the version after the update (new app version, else the running one) is skipped. A model for a newer app thus only comes with that app.
- **Layout:** manifest layout first, else the local catalog's. Without a new app the layout must equal the local one (the running app must find the model). A model is skipped if its folder equals, contains or lies inside another model's folder (an archive swap replaces its whole folder). Retired ids (`RETIRED_MODELS`) never come back.

The update is identified by `bundleKey()` (app version/sha + sorted `id@sha256`); a changed key replaces a waiting or downloading update, already staged parts are reused. Nothing is selected before the first-launch download is complete (`checkModelsExist()`) or in the dev build (a relaunch would kill the dev server). Downloading or deleting a model in Settings → Modelle recomputes the update (`handleModelsChanged()`); a Settings download pauses staging first (`withStagingPaused()`, strictly one download at a time) and staging resumes afterwards.

### Staging (restart-proof)

Parts are staged one after another, app first:

- **App:** DMG download → sha256 vs. signed manifest → `hdiutil attach` on a private mount point → `ditto --noqtn` into `userData/app-update/<version>/` → `hdiutil detach` → check version, `codesign --verify --deep --strict` and the Designated Requirement (`identifier "com.therascript.app"`, #161).
- **Models** (`src/main/services/model-staging.ts`): into `~/.therascript/models/.update/<sha256>/` — on the same volume as the models (the swap is a rename), outside the legacy `models/.staging` that `cleanupIncompleteUpdates()` still wipes at every start. Download (`artifact.tar.gz|.bin`, resumes via `.partial` after a restart) → sha256 vs. signed manifest → archive: `/usr/bin/tar` via `runSubprocess` (abortable) into `payload.tmp/`, reject symlinks pointing outside the tree, require `checkPath` inside → rename to `payload`. «Staged» means `payload` exists; the folder is content-addressed, a new version lands elsewhere by itself.

Legacy (pre-#167): `cleanupIncompleteUpdates()` still deletes `models/.staging` and restores a model from `models/.backup` after an interrupted swap of the old model-update flow — needed once for installations updating from v0.9.x; remove after a few releases. `migrateInstalledVersions()` seeds `installedModelVersions` for models already on disk (`version: 'pre-update'`, `sha256: ''`).

Disk space (NFR 1): `diskNeedBytes` = app × 5 + archive model × 2.5 + flat model × 1 (only parts not yet staged), checked against the free space of both the app work dir and the models dir. Manual: need must fit, else «Nicht genügend Speicherplatz … mindestens N GB». Automatic (AK 8): 5 GB must remain free afterwards, else a hint naming the space.

### Phases

| Phase | Meaning |
|---|---|
| `idle` | no update known — up to date, not yet checked or last check failed (`checkedAt`, `checkFailed`) |
| `available` | update known, not fully staged (auto-update off, too little space — with a hint naming the space needed — or a failed background download); always shown in the bottom bar |
| `downloading` | staging of all parts (see above); progress weighted by size |
| `ready` | all parts staged and verified; persisted in the `appUpdate` setting so a restart keeps it |
| `unsupported` | only a new app version that cannot replace itself (not in `/Applications` or `~/Applications`, App Translocation, DMG volume, no write permission or foreign owner) → hint with the website installation guide |

`AppUpdateState` carries `version` (app part, `null` = model-only update), `sizeBytes` (total download, AK 3), `appSizeBytes`, `models[]` (`label`, `sizeBytes`, `kind: 'update' | 'new'`), `diskNeedBytes`, and `manualVersion`/`unsupportedReason` for an app part that needs a manual install.

A background download stays invisible while it runs; if it fails, the update shows up as `available` without an error text (retry at the next check, or download by hand). A download interrupted by quitting resumes at the next start. A manual download shows progress, can be cancelled and reports errors. A newer version replaces a waiting or downloading one.

Cancelling aborts the running step (`AbortSignal` into download, `hdiutil`, `ditto`, `codesign`); the next run waits until the cancelled one has detached its DMG (`lastRun`), so two runs never share a mount point or staging folder. Folders are deleted by first renaming them to `<name>.deleting-<ts>` (atomic) and then running `/bin/rm` in the background via `runSubprocess` — a download starting right after a replacement can never land in a folder that `rm` is still emptying. `init()` sweeps leftover `.deleting-` folders.

### Installing

- **Triggers:** click in Settings → Updates or in the menu-bar item «Version X installieren» / «Modell-Update installieren» (same label as the button, `shared/utils/updateTitle.ts`); automatically after 10 minutes without input (`powerMonitor.getSystemIdleTime`, checked every minute) or when the app quits — the latter two only with automatic updates on.
- **Never interrupt work:** `WorkGuard.currentWork()` (recording, running **or pending** task — `TaskQueueService.hasWork()`, model download in first launch or Settings) is checked immediately before installing. A click during work marks the install as pending; it runs as soon as nothing is busy. The quit decision is taken at the very beginning of `before-quit`, before the recording cleanup.
- **Swap (only renames, NFR 5):** after the ordered shutdown (queue stopped, DB closed), first the models — per model `models/<relativePath>` → `models/.update/backup/<id>`, `payload` → `models/<relativePath>` (`swapModelsIn`) — then the app: `Therascript.app` → `.Therascript-previous.app`, staged copy → `Therascript.app`. The app swap is the commit point. If any rename fails, everything is renamed back (`rollbackModels`, decided purely from the disk state, idempotent) — app and models stay at the previous state (PC 2). A model-only update relaunches as well (AK 2). Then `app.exit(0)` (with `app.relaunch()` for a click/idle install). **Not `app.quit()`:** after renaming its own bundle macOS aborts a regular termination and the process lingers (measured on the packaged app). Quit incl. swap: ~150 ms. While quitting the update is frozen — a late check must not clear what is being installed.
- **Hidden window:** if the window was hidden, `startHiddenAfterUpdate` makes the relaunch start with `show: false` and ignore the launch `activate` event.
- **Next start:** `init()` evaluates the journal (`installAttemptedAt`) against the disk: app version reached **and** every model swapped in (`payload` gone, `checkPath` present) → success: only now the new model versions go into `installedModelVersions`, staging, model backups and the previous bundle are removed (via `/bin/rm` — Electron's `fs` treats `app.asar` inside a bundle as a virtual directory and silently deletes nothing). Otherwise (failed swap, crash in the middle) → `rollbackModels`, status «nicht gelungen … automatisch erneut», the update stays ready. After `MAX_SILENT_INSTALL_ATTEMPTS` (3) failures it installs only on click — no endless idle-restart loop. The persisted update is then re-validated against today's state (app updated by hand, model deleted → that part drops out). If the app now cannot replace itself (e.g. started from the DMG), the app part becomes «von Hand», so no swap is attempted on every quit. `migrateInstalledVersions()` runs **before** `init()`: otherwise the success path would write versions first and the migration would skip the legacy models.

### Automatic updates (#165)

Setting `autoUpdate` (default `true`, also for existing installations via electron-store defaults) — covers app **and** models. Off: no automatic download or install (also not on quit); checks continue and updates are shown; an update already downloaded stays installable; a running background download is cancelled. An update can be postponed but not skipped (#167 AK 5) — there is no dismiss any more; the former `dismissedManifestVersions` and `pendingModelUpdates` settings are deleted at start, so a previously skipped model is offered again once. UI: Settings → Updates (`UpdateSettings.tsx`, `Toggle.tsx`); the bottom bar shows «Update bereit» / «Update verfügbar» and opens that page — whenever `updateNeedsAttention()` (`useAppUpdate.ts`, also used for the highlighted Settings card) is true: phase `ready`, `unsupported` or `available`.

## electron-store Keys

| Key | Type | Purpose |
|-----|------|---------|
| `modelsDownloaded` | `boolean` | Set to `true` after first-launch download completes |
| `installedModelVersions` | `Record<string, { version, sha256, installedAt }>` | Tracks installed model versions for update comparison |
| `autoUpdate` | `boolean` | Automatic updates of app and models (download + install), default `true` (#165, #167) |
| `appUpdate` | `PersistedUpdate \| null` | The selected update: app part (incl. staged path), models with layout, install journal, failure count (#164, #167; the pre-#167 app-only shape is read and migrated) |
| `startHiddenAfterUpdate` | `boolean` | Start the relaunched app with a hidden window (#164) |

## IPC Channels

### Model Download (First Launch)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `modelDownload:status` | handle | Returns `{ modelsReady, models[] }` |
| `modelDownload:checkDiskSpace` | handle | Returns `{ sufficient, availableBytes, requiredBytes }` |
| `modelDownload:start` | handle | Starts sequential model download |
| `modelDownload:status` (event) | send | Pushes `ModelDownloadStatus` progress to renderer |

### App Updates

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `appUpdate:getState` | handle | Current `AppUpdateState` |
| `appUpdate:check` | handle | Manifest check (app + models), returns the state |
| `appUpdate:download` / `appUpdate:cancelDownload` | handle | Manual download with progress |
| `appUpdate:install` | handle | Install now (relaunch) or mark as pending while work runs |
| `appUpdate:setAutoUpdate` | handle | Toggle automatic updates |
| `appUpdate:openInstallGuide` | handle | Website installation guide (fallback when the app cannot replace itself) |
| `appUpdate:state` | send | Pushes every state change |

## ASR Model Catalog

Since v0.5, the ASR model is user-selectable. `ModelDefinition` has two categorization fields:

- **`group`**: `'asr' | 'diarization' | 'ner'` — drives which helpers apply (`getAsrModels()`, `getRequiredModels()`).
- **`isRequired`**: required models are downloaded automatically on first launch and cannot be deleted. Only `pyannote-community-1` and `flair-ner-german-large` are required.

### First-Launch Scope

`checkModelsExist()` delegates to `checkRequiredAndActiveAsrExist(activeAsrId)`, which requires **only** the required models **plus** the active ASR model (`activeModels.transcription` in electron-store) to be present. Optional ASR alternatives are downloaded on demand via Settings → Models.

### Available ASR Models

| ID | Languages | Size | Use case |
|---|---|---|---|
| `whisper-large-v3-turbo` (default) | Multilingual | 574 MB | General-purpose — handles High German, English, and more. |
| `whisper-large-v3-turbo-german` | High German | 574 MB | Fine-tune for standard German (base: primeline/whisper-large-v3-turbo-german, Apache 2.0). More precise on High German; not suitable for strong Swiss-German dialect or other languages. |

**Retired:** `whisper-large-v3-turbo-swiss` (CC BY-NC 4.0, not usable in paid therapy practices). `retireObsoleteModels()` deletes the file on the first start of the new version and clears the slot. Because ASR is a required group, the reconciler then activates an installed successor (default first) — or, without any installed ASR model, the first-launch screen downloads the default (`getModelsToLoadOnFirstLaunch`) and the reconciler activates it afterwards. Either way the reconciler completes the pending `model-retired` event with the successor instead of adding a `default-promoted`, so the user sees one notice.

### Settings → Models

The tab in `src/renderer/src/views/Settings.tsx` renders `ModelsSettings.tsx`. The component:

- Lists ASR models in two sections (Installed / Available for Download).
- Shows an active badge, language chips, size label, and a descriptive paragraph per model.
- Offers Download / Delete / Activate / Cancel-download actions.
- Uses `ConfirmDialog` + `useToast()` for destructive confirmation and success/error feedback.
- Displays required models read-only as an info block.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `modelCatalog:listAsr` | handle | Returns all ASR models with `isInstalled`/`isActive` flags |
| `modelCatalog:download` | handle | Downloads a single ASR model (uses the shared `abortSignal` singleton) |
| `modelCatalog:delete` | handle | Deletes a model (guards: not required, not active) |
| `modelCatalog:setActive` | handle | Switches `activeModels.transcription` (guard: installed) |
| `modelCatalog:cancelDownload` | handle | Aborts an in-flight download |

### Release Flow for New ASR Models

1. `scripts/convert-hf-whisper.sh <hf-repo> <output-basename>` — converts a HuggingFace Whisper model via `convert-h5-to-ggml.py` and quantizes to `q5_0`. Output: `r2-upload/<basename>.bin`. Prints SHA-256 and size.
2. Upload the file to R2 (via `aws s3 cp`).
3. Add an entry to `MODEL_DEFINITIONS` (`ModelDownloadService.ts`): `group: 'asr'`, `isRequired: false`, `description`, `languages`, `accuracyScore`, `speedScore`, plus the correct `sha256` and `sizeBytes`.
4. Ship an app release — `release.sh` publishes the signed manifest from the catalog (hash sync, see CLAUDE.md "Model hash sync").
