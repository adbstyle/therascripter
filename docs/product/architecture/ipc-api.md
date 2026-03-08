# IPC API Reference

Therascript uses Electron's IPC (Inter-Process Communication) to bridge the renderer (React UI) and main (Node.js) processes. Every channel that accepts input validates it with a Zod schema before processing. The preload script exposes a typed `window.api` object via `contextBridge`, grouping channels into namespaces.

## Validation Approach

All incoming IPC arguments are typed as `unknown` and parsed through Zod schemas before any business logic executes. Schemas live in `src/shared/validation/` and are imported by both main-process handlers and TypeScript types.

**On validation failure:** `schema.parse(args)` throws a `ZodError`, which Electron serializes back to the renderer as a rejected promise (for `invoke`) or silently drops (for `send`/`on`). No partial processing occurs — validation is the first operation in every handler.

**Schema location by handler group:**

| Handler Group | Schema File |
|---|---|
| session | `src/shared/validation/session-schemas.ts` |
| recording | `src/shared/validation/recording-schemas.ts` |
| task | `src/shared/validation/task-schemas.ts` |
| review | `src/shared/validation/review-schemas.ts` |
| blocklist | `src/shared/validation/blocklist-schemas.ts` |
| import (pdf) | `src/shared/validation/import-schemas.ts` |
| settings | `src/shared/validation/settings-schemas.ts` |
| system | `src/shared/validation/system-schemas.ts` |
| model-update, app-update | `src/shared/validation/model-update-schemas.ts` |
| model-download | _(no input schemas — all channels are parameterless)_ |

---

## Preload Context Bridge

The preload script (`src/preload/index.ts`) exposes two objects on `window`:

- **`window.electron`** — Standard Electron toolkit API (`@electron-toolkit/preload`)
- **`window.api`** — Therascript IPC API (typed as `IpcApi`)

The `api` object contains the following namespaces:

| Namespace | Methods |
|---|---|
| `api.sessions` | `list()`, `delete(sessionId)`, `rename(sessionId, title)` |
| `api.recording` | `start()`, `stop(sessionId)`, `sendData(sessionId, samples)`, `onDuration(cb)`, `onError(cb)`, `onAutoStopped(cb)` |
| `api.settings` | `get(key)`, `set(key, value)` |
| `api.tasks` | `getSessionTasks(sessionId)`, `isProcessing()`, `onProgress(cb)`, `onCompleted(cb)`, `onError(cb)` |
| `api.blocklist` | `list()`, `add(term, placeholderType)`, `update(id, term, placeholderType)`, `delete(id)` |
| `api.import` | `pdf(filePaths)`, `showPDFDialog()`, `getPathForFile(file)` |
| `api.review` | `load(sessionId)`, `save(sessionId, document, entityMap)`, `exportClipboard(text)` |
| `api.system` | `aboutInfo()`, `uninstall()`, `openInFinder(path)` |
| `api.modelDownload` | `status()`, `checkDiskSpace()`, `start()`, `onStatus(cb)` |
| `api.modelUpdate` | `check()`, `restart(updates)`, `startDownload()`, `getPending()`, `clearPending()`, `onAvailable(cb)`, `onDownloadProgress(cb)`, `onDownloadComplete(cb)`, `onDownloadError(cb)` |
| `api.appUpdate` | `getStatus()`, `check()`, `openReleasePage()`, `onStatus(cb)` |

All `on*` listener methods return an unsubscribe function `() => void`.

Note: `api.import.getPathForFile(file)` is a local call to `webUtils.getPathForFile()` — it does not use IPC.

---

## Handler Groups

### Session Handlers

Source: `src/main/ipc/session-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `session:list` | invoke | _(none)_ | `Session[]` | List all sessions ordered by creation date |
| `session:delete` | invoke | `SessionDeleteSchema` — `{ sessionId: string }` | `void` | Delete a session and its associated files |
| `session:rename` | invoke | `SessionRenameSchema` — `{ sessionId: string, title: string(1..200) }` | `void` | Rename a session title |

### Recording Handlers

Source: `src/main/ipc/recording-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `recording:start` | invoke | _(none)_ | `{ sessionId: string }` | Create a new audio session and begin recording. Starts duration timer, power save blocker, 2h auto-stop timer, and tray indicator. Throws if a recording is already active. |
| `recording:stop` | invoke | `RecordingStopSchema` — `{ sessionId: string }` | `{ durationSeconds: number }` | Stop the active recording, finalize WAV file, set session status to `transcribing`, and enqueue ML pipeline. Throws if sessionId does not match the active recording. |
| `recording:data` | send (one-way) | `RecordingDataSchema` — `{ sessionId: string, samples: ArrayBuffer }` | _(none)_ | Stream raw audio samples from the renderer's MediaRecorder to the main process for WAV writing. Uses `ipcMain.on` (fire-and-forget). |

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `recording:duration` | `{ seconds: number }` | Emitted every 1 second with elapsed recording time |
| `recording:error` | `{ message: string }` | Emitted when audio chunk writing fails |
| `recording:auto-stopped` | _(none)_ | Emitted when the 2h auto-stop timer fires or recording is stopped from the system tray |

### Task Handlers

Source: `src/main/ipc/task-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `task:getSessionTasks` | invoke | `GetSessionTasksSchema` — `{ sessionId: string }` | `Task[]` | Get all pipeline tasks for a session |
| `task:isProcessing` | invoke | _(none)_ | `boolean` | Check if the task queue is currently processing any task |

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `task:progress` | `TaskProgressData` | Emitted during ML pipeline execution with progress percentage and status text |
| `task:completed` | `TaskCompletedData` | Emitted when a pipeline task completes successfully |
| `task:error` | `TaskErrorData` | Emitted when a pipeline task fails |

### Review Handlers

Source: `src/main/ipc/review-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `review:load` | invoke | `ReviewLoadSchema` — `{ sessionId: string }` | `{ document: TipTapDoc, entityMap: EntityMap }` | Load the anonymized TipTap document and entity map for review |
| `review:save` | invoke | `ReviewSaveSchema` — `{ sessionId: string, document: { type: "doc", content: any[] }, entityMap: Record<string, EntityMapEntry> }` | `void` | Save edited document and entity map back to storage |
| `review:exportClipboard` | invoke | `ReviewExportClipboardSchema` — `{ text: string }` | `void` | Copy anonymized plain text to the system clipboard |

The `entityMap` values are validated as objects with fields: `original: string`, `placeholder: string`, `type: PlaceholderType`, `source: "ner" | "blocklist" | "manual"`.

### Blocklist Handlers

Source: `src/main/ipc/blocklist-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `blocklist:list` | invoke | _(none)_ | `BlocklistEntry[]` | List all blocklist entries |
| `blocklist:add` | invoke | `BlocklistAddSchema` — `{ term: string(1..200), placeholderType: PlaceholderType }` | `BlocklistEntry` | Add a new term to the blocklist |
| `blocklist:update` | invoke | `BlocklistUpdateSchema` — `{ id: string, term: string(1..200), placeholderType: PlaceholderType }` | `BlocklistEntry` | Update an existing blocklist entry |
| `blocklist:delete` | invoke | `BlocklistDeleteSchema` — `{ id: string }` | `void` | Delete a blocklist entry by ID |

`PlaceholderType` is an enum: `PERSON | ORT | DATUM | KONTAKT | ORGANISATION | MEDIZINISCH | SONSTIGES`.

### PDF Import Handlers

Source: `src/main/ipc/pdf-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `import:pdf` | invoke | `ImportPDFSchema` — `{ filePaths: string[](1..20) }` | `Session[]` | Import one or more PDF files. Copies each to `~/.therascript/pdf/`, creates a session, and enqueues the PDF processing pipeline. Rolls back on copy failure. |
| `import:showPDFDialog` | invoke | _(none)_ | `string[]` | Open a native file picker dialog for PDF selection. Returns selected file paths, or empty array if canceled. |

### Model Download Handlers

Source: `src/main/ipc/model-download-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `modelDownload:status` | invoke | _(none)_ | `{ modelsReady: boolean, models: { id, label, sizeBytes }[] }` | Check whether all required models are present and list model definitions |
| `modelDownload:checkDiskSpace` | invoke | _(none)_ | `{ sufficient: boolean, availableBytes: number, requiredBytes: number }` | Check if 5 GB minimum disk space is available |
| `modelDownload:start` | invoke | _(none)_ | `void` | Begin downloading all missing models. Progress is reported via the `modelDownload:status` event channel. |

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `modelDownload:status` | `ModelDownloadStatus` | Emitted during model downloads with per-model progress and overall status |

### Model Update Handlers

Source: `src/main/ipc/model-update-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `modelUpdate:check` | invoke | _(none)_ | `PendingModelUpdate[]` | Check R2 manifest for newer model versions. Returns list of available updates. |
| `modelUpdate:restart` | invoke | `RestartUpdateSchema` — `{ updates: PendingModelUpdate[] }` | `{ allowed: boolean, reason?: string }` | Request app restart to apply model updates. Refused if recording or processing is active (`reason: "recording"` or `"processing"`). |
| `modelUpdate:startDownload` | invoke | _(none)_ | `void` | Start downloading pending model updates (called from ModelUpdateScreen after restart) |
| `modelUpdate:getPending` | invoke | _(none)_ | `PendingModelUpdate[] \| null` | Retrieve pending updates stored in electron-store settings |
| `modelUpdate:clearPending` | invoke | _(none)_ | `void` | Clear pending updates from settings (used when user skips update) |

`PendingModelUpdate` schema fields: `id`, `version`, `label`, `url` (URL), `sha256` (64 hex chars), `sizeBytes` (positive int), `relativePath`, `archive?` (boolean), `checkPath`.

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `modelUpdate:available` | `PendingModelUpdate[]` | Emitted when new model versions are detected during background check |
| `modelUpdate:downloadProgress` | `ModelDownloadStatus` | Emitted during model update download with progress data |
| `modelUpdate:downloadComplete` | _(none)_ | Emitted when all model updates have been downloaded and applied |
| `modelUpdate:downloadError` | `string` | Emitted when a model update download fails, with error message |

### App Update Handlers

Source: `src/main/ipc/app-update-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `appUpdate:getStatus` | invoke | _(none)_ | `{ available: boolean, latestVersion: string \| null, checkedAt: string \| null }` | Return cached app update status from electron-store. Validated against `AppUpdateStatusSchema` on read. |
| `appUpdate:check` | invoke | _(none)_ | `{ modelUpdates: PendingModelUpdate[], appUpdate: AppUpdateStatus }` | Trigger a full consolidated check (model + app) against the R2 manifest |
| `appUpdate:openReleasePage` | invoke | _(none)_ | `void` | Open the GitHub Releases page in the default browser |

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `appUpdate:status` | `AppUpdateStatus` | Emitted when a background check detects a new app version |

### Settings Handlers

Source: `src/main/ipc/settings-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `settings:get` | invoke | `SettingsGetSchema` — `{ key: SettingsKey }` | `unknown` | Read a setting value from electron-store |
| `settings:set` | invoke | `SettingsSetSchema` — `{ key: SettingsKey, value: unknown }` | `void` | Write a setting value. When `key` is `"theme"`, also syncs Electron's `nativeTheme.themeSource`. |

`SettingsKey` is an enum: `activeModels | firstLaunchDone | consentReminderShown | modelsDownloaded | theme`.

### System Handlers

Source: `src/main/ipc/system-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `system:aboutInfo` | invoke | _(none)_ | `AboutInfo` | Gather system information: app version, Electron version, macOS version, chip name, total RAM, FileVault status, storage usage (models + sessions), data directory path |
| `system:openInFinder` | invoke | `OpenInFinderSchema` — `{ path: string }` | `void` | Open a file or directory in Finder |
| `system:uninstall` | invoke | _(none)_ | `boolean` | Show confirmation dialog, then delete all app data (`~/.therascript/`), settings, and quit. Returns `false` if user cancels. |

---

## Channel Summary

### All invoke channels (renderer -> main, request/response)

| Channel | Handler Group |
|---|---|
| `session:list` | session |
| `session:delete` | session |
| `session:rename` | session |
| `recording:start` | recording |
| `recording:stop` | recording |
| `task:getSessionTasks` | task |
| `task:isProcessing` | task |
| `review:load` | review |
| `review:save` | review |
| `review:exportClipboard` | review |
| `blocklist:list` | blocklist |
| `blocklist:add` | blocklist |
| `blocklist:update` | blocklist |
| `blocklist:delete` | blocklist |
| `import:pdf` | pdf |
| `import:showPDFDialog` | pdf |
| `modelDownload:status` | model-download |
| `modelDownload:checkDiskSpace` | model-download |
| `modelDownload:start` | model-download |
| `modelUpdate:check` | model-update |
| `modelUpdate:restart` | model-update |
| `modelUpdate:startDownload` | model-update |
| `modelUpdate:getPending` | model-update |
| `modelUpdate:clearPending` | model-update |
| `appUpdate:getStatus` | app-update |
| `appUpdate:check` | app-update |
| `appUpdate:openReleasePage` | app-update |
| `settings:get` | settings |
| `settings:set` | settings |
| `system:aboutInfo` | system |
| `system:openInFinder` | system |
| `system:uninstall` | system |

### All send channels (renderer -> main, fire-and-forget)

| Channel | Handler Group |
|---|---|
| `recording:data` | recording |

### All event channels (main -> renderer, push)

| Channel | Handler Group |
|---|---|
| `recording:duration` | recording |
| `recording:error` | recording |
| `recording:auto-stopped` | recording |
| `task:progress` | task |
| `task:completed` | task |
| `task:error` | task |
| `modelDownload:status` | model-download |
| `modelUpdate:available` | model-update |
| `modelUpdate:downloadProgress` | model-update |
| `modelUpdate:downloadComplete` | model-update |
| `modelUpdate:downloadError` | model-update |
| `appUpdate:status` | app-update |
