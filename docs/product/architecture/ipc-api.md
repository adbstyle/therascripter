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
| dossier | `src/shared/validation/dossier-schemas.ts` |
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
| `api.sessions` | `list()`, `delete(sessionId)`, `rename(sessionId, title)`, `setDocumentDate(sessionId, documentDate)`, `onChanged(cb)` |
| `api.recording` | `start(options?)` (`{ dossierId? }`, #206), `stop(sessionId)`, `sendData(sessionId, samples)`, `onDuration(cb)`, `onError(cb)`, `onAutoStopped(cb)` |
| `api.settings` | `get(key)`, `set(key, value)` |
| `api.tasks` | `getSessionTasks(sessionId)`, `isProcessing()`, `onProgress(cb)`, `onCompleted(cb)`, `onError(cb)` |
| `api.blocklist` | `list()`, `add(term, placeholderType)`, `update(id, term, placeholderType)`, `delete(id)` |
| `api.import` | `pdf(filePaths, options?)` (`{ dossierId? }`, #206), `showPDFDialog()`, `getPathForFile(file)` |
| `api.review` | `load(sessionId)`, `save(sessionId, document, entityMap)`, `exportClipboard(text)` |
| `api.system` | `aboutInfo()`, `uninstall()`, `openInFinder(path)` |
| `api.modelDownload` | `status()`, `checkDiskSpace()`, `start()`, `onStatus(cb)` |
| `api.appUpdate` | `getState()`, `check()`, `download()`, `cancelDownload()`, `install()`, `setAutoUpdate(enabled)`, `openInstallGuide()`, `onState(cb)` |
| `api.dossiers` | `list()`, `get(dossierId)`, `create(input)`, `update(dossierId, patch)`, `deletePreview(dossierId)`, `delete(dossierId, fingerprint)`, `timeline(dossierId)`, `listForSession(sessionId)`, `assign(sessionId, dossierId)`, `unassign(sessionId, dossierId)`, `onChanged(cb)` — preload in `src/preload/api/dossiers.ts` |
| `api.search` | `query(input)`, `semantic(input)`, `recentList()`, `recentRemember(query)`, `recentClear()` — preload in `src/preload/api/search.ts` |
| `api.recent` | `list()`, `touch(target)`, `onChanged(cb)` — «Zuletzt geöffnet» (#213), preload in `src/preload/api/recent.ts` |

All `on*` listener methods return an unsubscribe function `() => void`.

Note: `api.import.getPathForFile(file)` is a local call to `webUtils.getPathForFile()` — it does not use IPC.

---

## Handler Groups

### Session Handlers

Source: `src/main/ipc/session-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `session:list` | invoke | _(none)_ | `SessionListItem[]` | All sessions (list projection) ordered by creation date, each with `dossiers: DossierRef[]` (alphabetical) for the badges (#205 AK 5) — a second query over all assignments, merged in `SessionDossierService.listSessions` |
| `session:setDocumentDate` | invoke | `SessionDocumentDateSchema` — `{ sessionId, documentDate: IsoDate }` (valid day, not after today, never `null`) | `{ok:true} \| {ok:false, reason:'not-found' \| 'not-pdf'}` | Document date of a PDF (#205 AK 18–22); sends `sessions:changed` and `dossiers:changed` |
| `session:delete` | invoke | `SessionDeleteSchema` — `{ sessionId: string }` | `void` | Delete a session and its associated files |
| `session:rename` | invoke | `SessionRenameSchema` — `{ sessionId: string, title: string(1..200) }` | `void` | Rename a session title |

**Event channels (main -> renderer, Epic #192):**

| Channel | Payload | Description |
|---|---|---|
| `sessions:changed` | `SessionsChangedSchema` — `{ deletedIds: string[] (max. 1000) }` | A session was created, or its status, title or summary changed, or it was deleted (`deletedIds`). Sent by `ChangeEvents.notifySessionsChanged` (`src/main/services/ChangeEvents.ts`), bundled per `setImmediate` so one tick yields one event; larger deletions are split. Lists reload via `useLiveQuery`; the navigation history removes deleted sessions (#213 PC 3). Path-only updates (pipeline intermediates) do not fire it. |

### Navigation (Epic #192)

Source: `src/main/services/AppMenuService.ts`, `src/main/index.ts`

| Channel | Direction | Payload | Description |
|---|---|---|---|
| `nav:command` | event | `NavCommandSchema` — `'back' \| 'forward' \| 'toggleSidebar'` | Menu «Gehe zu» → Zurück (⌘[) / Vorwärts (⌘]), «Darstellung» → Seitenleiste ein-/ausblenden (⌃⌘S). #209 adds `'search'`. |
| `nav:openSettings` | event | _(none)_ | App menu «Einstellungen…» (⌘,) and tray: opens the Settings overview |

### Recording Handlers

Source: `src/main/ipc/recording-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `recording:start` | invoke | `RecordingStartSchema` — none or `{ dossierId? }` (strict) | `RecordingStartResult` — `{ sessionId, assignment: 'none' \| 'assigned' \| 'failed', title, createdAt }` | Create a new audio session and begin recording. With `dossierId` the session is assigned to that dossier once the WAV file exists and the session is active — before any audio arrives (#206 PC 1); a failing `initWavFile` leaves neither an assignment nor a «Zuletzt» entry; a failed assignment does not stop the recording (`'failed'`, AK 2). Starts duration timer, power save blocker, 2h auto-stop timer, and tray indicator. Throws if a recording is already active. |
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
| `import:pdf` | invoke | `ImportPDFSchema` — `{ filePaths: string[](1..20), dossierId? }` (strict) | `ImportPdfResult` — `{ sessions: Session[], unassigned: {sessionId, title}[], failed: {title, reason}[] }` | Import one or more PDF files, each in its own try/catch (missing file, copy failure → `failed`; a PDF deleted while its scanned-pages check runs is skipped silently). Copies each to `~/.therascript/pdf/`, creates a session, assigns it to `dossierId` (if given) BEFORE enqueuing the PDF processing pipeline (#206 PC 2); PDFs whose assignment failed are imported anyway and listed in `unassigned` (AK 2). Rolls back on copy failure. |
| `import:showPDFDialog` | invoke | _(none)_ | `string[]` | Open a native file picker dialog for PDF selection. Returns selected file paths, or empty array if canceled. |

### Dossier Handlers

Source: `src/main/ipc/dossier-handlers.ts`, service `src/main/services/DossierService.ts`, types `src/shared/types/Dossier.ts` and `src/shared/types/ipc/DossierApi.ts`. Every handler validates with `validateIpc`; all objects are `.strict()`. Results are typed unions instead of exceptions, because Electron mangles error messages of `invoke`. Conventions: `Id` = string 1–64, names 1–100 (whitespace only counts as empty), dossier ID ≤ 50, free text ≤ 20 000, dates `YYYY-MM-DD` and a valid calendar day not after today (local time, checked on every call).

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `dossier:list` | invoke | _(none)_ | `DossierListItem[]` | Overview sorted by last name, first name (normalized). Each item: `id, firstName, lastName, externalId, birthDate, entryCount, lastEntryDay` — no diagnoses, medication or note |
| `dossier:get` | invoke | `DossierIdInputSchema` — `{ dossierId }` | `Dossier \| null` | All fields of one dossier |
| `dossier:create` | invoke | `DossierCreateSchema` — `{ firstName, lastName, externalId?: string \| null, birthDate?: IsoDate \| null, confirmDuplicate?: boolean }` | `CreateDossierResult` | `{ok:true, dossier}` · `{ok:false, reason:'external-id-taken', ownerName}` (owner as «Nachname, Vorname») · `{ok:false, reason:'duplicate-name', duplicates: DossierRef[]}` until called again with `confirmDuplicate: true` |
| `dossier:update` | invoke | `DossierUpdateSchema` — `{ dossierId, patch }`, patch = at least one of `firstName, lastName, externalId (string \| null), birthDate (IsoDate \| null), diagnoses, medication, note` | `UpdateDossierResult` | Autosave per field. `{ok:true, dossier, duplicates}` — a duplicate name is saved and only reported · `{ok:false, reason:'external-id-taken', ownerName}` (nothing saved) · `{ok:false, reason:'not-found'}` |
| `dossier:deletePreview` | invoke | `DossierIdInputSchema` | `DossierDeletePreview \| null` | `{dossierId, displayName, exclusive:{sessions, pdfs}, shared:{sessions, pdfs, otherDossiers}, search:{exclusiveSearchable, recentQueries}, blockedByRecording, fingerprint}` — `search` names the search data the dialog lists (#207) |
| `dossier:timeline` | invoke | `DossierIdInputSchema` | `TimelineEntry[]` | Timeline (#205): list projection + `dossiers` + `sortDay` (`YYYY-MM-DD`, local day: session = recording, PDF = document date or import day). Order: `sortDay` DESC, sessions before PDFs, `created_at` DESC, `id` DESC. Sessions being deleted are left out |
| `dossier:listForSession` | invoke | `SessionIdInputSchema` — `{ sessionId }` | `DossierRef[]` | Dossiers of one session, alphabetical (editor header) |
| `dossier:assign` / `dossier:unassign` | invoke | `DossierAssignmentSchema` — `{ sessionId, dossierId }` | `{ok:true} \| {ok:false, reason:'not-found'}` | No status check (assign also while recording/processing/after an error); assign is idempotent; unassign is followed by a WAL checkpoint. Both send `sessions:changed` and `dossiers:changed` when something changed |
| `dossier:delete` | invoke | `DossierDeleteSchema` — `{ dossierId, fingerprint: string(≤128) }` | `DeleteDossierResult` | `{ok:true, deletedSessionIds, incomplete}` · `{ok:false, reason:'changed', preview}` (nothing deleted) · `{ok:false, reason:'blocked-recording' \| 'not-found'}` — see storage.md «Deleting a patient dossier» |

**Events (main → renderer):**

| Channel | Payload | Description |
|---|---|---|
| `dossiers:changed` | `{ deletedIds: string[] }` (≤ 1000, parsed with `DossiersChangedSchema` in the preload) | After create, after an update of name, dossier ID or birth date (not for free text — it is shown nowhere else), after a deletion with the deleted ID, after assigning/unassigning and after setting a document date (#205) |
| `sessions:changed` | `{ deletedIds: string[] }` | Also sent by the dossier deletion with the IDs of the sessions it deleted (via `DossierService`; `SessionService.finishDeletion` itself does not notify, so nothing is sent twice). All other triggers: see «Session Handlers» |

Both events go through `src/main/services/ChangeEvents.ts` (`notifyDossiersChanged`, `notifySessionsChanged`): bundled with `setImmediate`, so one tick yields at most one event per channel with the union of deleted IDs; more than 1000 IDs are split. Without a window nothing is sent. Limit and schemas: `src/shared/validation/change-event-schemas.ts`. The renderer removes deleted dossiers from its page history (current page → `dossiers` overview).

### Search Handlers (Epic #192)

Source: `src/main/ipc/search-handlers.ts`, service `src/main/search/SearchService.ts`, types `src/shared/types/Search.ts` and `src/shared/types/ipc/SearchApi.ts`, schemas `src/shared/validation/search-schemas.ts` (all `.strict()`). Feature description: `docs/product/features/search.md`. PR S2 added `search:open`, `search:retryModel` and the event `search:availabilityChanged` (search model availability); PR S4 added `search:semantic`, the field `semantic` of `SearchAvailability` (processing and search process) and the preloading in `search:open`.

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `search:query` | invoke | `SearchQueryInputSchema` — `{ requestId: int ≥ 0, query: string(1..200, not blank, no control characters), scope: {kind:'all'} \| {kind:'dossier', dossierId} }` | `SearchQueryResult` | `{requestId, dossiers, results, truncated, semantic}`. `dossiers` (only for `scope.kind === 'all'`, ≤ 20): `DossierRef[]` matched by name parts or dossier ID. `results` (≤ 100): one `SearchDocumentResult` per session/PDF — `sessionId, type, title, titlePlain, sortDay, dossiers, hits` with ≤ 3 `SearchHit {field, kind, label {speaker?, timestamp?}, snippet {text, marks, truncatedStart, truncatedEnd}, focus}`; `focus` = `{kind:'title'}` · `{kind:'summary'}` · `{kind:'hit', paraFrom, paraTo, ranges?: {p,s,e}[], anchor}`. `semantic`: `'pending'` (call `search:semantic`) or why the search by meaning is unavailable: `'unavailable-processing'` · `'model-missing'` · `'tool-blocked'` · `'error'` |
| `search:semantic` | invoke | `SearchQueryInputSchema` | `SearchQueryResult` | Search by meaning merged with the exact hits (exact first, inside by cosine, all sections ≥ threshold, dossier filter after the ranking). `semantic`: `'complete'`; `'superseded'` when a newer request of the same window and scope replaced it; a hit from the previous vector generation carries `fromEarlierVersion: true` (find it by `anchor`); otherwise the reason as above — `results` then holds the exact hits |
| `search:recent:list` | invoke | _(none)_ | `RecentSearchQuery[]` | The five last searches, newest first: `{query, usedAt}` |
| `search:recent:remember` | invoke | `SearchRecentRememberSchema` — `{ query }` | `void` | Put a query on top (deduplicated by its normalized form, at most five). Only from the search over everything (#211 OOS 3) |
| `search:recent:clear` | invoke | _(none)_ | `void` | Delete all recent searches, then WAL checkpoint (#209 PC 3) |
| `search:open` | invoke | _(none)_ | `SearchAvailability` | Starts preloading the search model and vectors when the search by meaning is possible (#209 AK 16) and answers at once. `{ model: SearchModelState, semantic }` — `semantic`: `ready` · `loading` · `unavailable-processing` · `model-missing` · `tool-blocked` · `error`, optional `semanticMessage` (German sentence for `error`/`tool-blocked`); `model`: `ready` · `downloading {progress}` · `retry-scheduled {reason, nextAttemptAt}` · `failed {reason}` · `unpublished`; reasons `network \| disk-space \| checksum \| extract \| unknown` (#210 AK 4/5) |
| `search:retryModel` | invoke | _(none)_ | `SearchAvailability` | «Erneut versuchen»: download the search model now, resolves after the attempt |
| `search:availabilityChanged` | send (main → renderer) | — | `SearchAvailability` | Every change of the model (including download progress, whole percent) or of the search process / processing |

### Recent Handlers (Epic #192, #213)

`src/main/ipc/recent-handlers.ts`, service `src/main/services/RecentService.ts`, repository `src/main/db/repositories/RecentRepository.ts`.

| Channel | Type | Payload | Returns | Description |
|---|---|---|---|---|
| `recent:list` | invoke | _(none)_ | `RecentEntry[]` | At most eight entries, newest first; the running recording (`getActiveSessionId`) always first, even if it fell out of the eight. `{kind:'dossier', dossier: DossierRef}` or `{kind:'session', session: Session (list projection incl. `titlePlain`), recording}`. Sessions with `deleting_at` are never listed |
| `recent:touch` | invoke | `RecentTouchSchema` — `{kind:'dossier'\|'session', id}` (strict, discriminated) | `void` | Put an opened dossier or session on top (upsert, strictly increasing `opened_at`), keep eight; unknown or deleting targets are ignored. Sent by the renderer on every dossier/session route (`useRememberOpenedRoute` in `AppShell`); `recording:start` touches the new session itself. Imported PDFs are not touched (not opened) |
| `recent:changed` | event | `RecentChangedSchema` — `{ deletedIds: [] }` | – | After a touch; `RecentList` also reloads on `sessions:changed`/`dossiers:changed` (titles, status, deletions) |

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

### App Update Handlers

Source: `src/main/ipc/app-update-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `appUpdate:getState` | invoke | _(none)_ | `AppUpdateState` | Current update state from `AppUpdateService` — app and models as one update (Issues #164/#165/#167) |
| `appUpdate:check` | invoke | _(none)_ | `AppUpdateState` | Trigger a full consolidated check (model + app) against the signed R2 manifest |
| `appUpdate:download` | invoke | _(none)_ | `void` | Start a manual download (progress via `appUpdate:state`) |
| `appUpdate:cancelDownload` | invoke | _(none)_ | `void` | Cancel the running download |
| `appUpdate:install` | invoke | _(none)_ | `AppUpdateInstallResult` | Install a ready update now, or mark it pending while work is running |
| `appUpdate:setAutoUpdate` | invoke | `{ enabled: boolean }` | `void` | Setting «Automatische Updates» (#165) |
| `appUpdate:openInstallGuide` | invoke | _(none)_ | `void` | Open the installation guide on the website (manual update path) |

**Event channels (main -> renderer):**

| Channel | Payload | Description |
|---|---|---|
| `appUpdate:state` | `AppUpdateState` | Every change of the app update state |

### Settings Handlers

Source: `src/main/ipc/settings-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `settings:get` | invoke | `SettingsGetSchema` — `{ key: SettingsKey }` | `unknown` | Read a setting value from electron-store |
| `settings:set` | invoke | `SettingsSetSchema` — `{ key: SettingsKey, value: unknown }` | `void` | Write a setting value. When `key` is `"theme"`, also syncs Electron's `nativeTheme.themeSource`. |

`SettingsKey` is an enum: `activeModels | firstLaunchDone | consentReminderShown | modelsDownloaded | theme | reviewPanelOpen | sidebarOpen` (`sidebarOpen`: sidebar shown, default `true`, Epic #192).

#### View mode (Issue #203)

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `viewMode:getSync` | sendSync | _(none)_ | `ViewMode` | Read by the preload **synchronously** before the renderer runs (`window.api.viewMode.initial`), so the first render already shows the saved view. Unknown/unreadable → `'pseudonymized'` |
| `sidebarOpen:getSync` | sendSync | _(none)_ | `boolean` | Read by the preload synchronously (`window.api.nav.initialSidebarOpen`, Epic #192) so the sidebar never flashes at start. Anything but `false` → `true` |
| `viewMode:set` | invoke | `ViewModeSetSchema` — `{ mode: 'pseudonymized' \| 'plain' }` | `void` | Persist the chosen view (electron-store `viewMode`) |

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
| `appUpdate:getState` | app-update |
| `appUpdate:check` | app-update |
| `appUpdate:download` | app-update |
| `appUpdate:cancelDownload` | app-update |
| `appUpdate:install` | app-update |
| `appUpdate:setAutoUpdate` | app-update |
| `appUpdate:openInstallGuide` | app-update |
| `settings:get` | settings |
| `settings:set` | settings |
| `system:aboutInfo` | system |
| `system:openInFinder` | system |
| `system:uninstall` | system |
| `search:query` | search |
| `search:semantic` | search |
| `search:recent:list` | search |
| `search:recent:remember` | search |
| `search:recent:clear` | search |
| `search:open` | search |
| `search:retryModel` | search |
| `recent:list` | recent |
| `recent:touch` | recent |

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
| `appUpdate:state` | app-update |
| `sessions:changed` | session (ChangeEvents) |
| `recent:changed` | recent (ChangeEvents) |
| `nav:command` | app menu |
| `nav:openSettings` | app menu / tray |
| `search:availabilityChanged` | search (SearchModelProvisioner, SearchWorker) |

### Tool Health (Issue #168)

Source: `src/main/ipc/tool-health-handlers.ts`

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `toolHealth:getState` | invoke | _(none)_ | `ToolHealthState \| null` | Status of the bundled tools (`checking` / `ok` / `blocked`, blocked tools, bundle path) |
| `toolHealth:recheck` | invoke | _(none)_ | `ToolHealthState \| null` | Check again (and repair silently if the app is approved) |
| `toolHealth:openGuide` | invoke | _(none)_ | `void` | Opens the installation guide (way without terminal) |
| `toolHealth:state` | event | — | `ToolHealthState` (`ToolHealthStateSchema`) | Every change of the tool status |

### Summary — blocked tools (Issue #168)

| Channel | Direction | Input Schema | Return Type | Description |
|---|---|---|---|---|
| `summary:missingReason` | invoke | `SummaryGetInputSchema` | `'tool-blocked' \| null` | Why the summary is missing: the last attempt failed on a tool blocked by macOS |
| `summary:regenerate` | invoke | `SummaryGetInputSchema` | `boolean` | Enqueue one summarization task for a review session; false if nothing to do |

Since Issue #203, `summary:updateTitle` and `summary:updateText` resolve with the updated `SummaryRecord` (incl. `titleSnapshot`/`textSnapshot`), and `session:list` rows carry `titlePlain`/`summaryPlain`, resolved in the main process.
| `summary:changed` | event | — | `{ sessionId }` (`SummaryChangedSchema`) | A summarization attempt failed — reload the hint |
