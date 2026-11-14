# Architecture Overview

Therascript is an Electron-based macOS desktop application for on-device transcription and anonymization of therapy sessions. All ML processing runs locally — no data leaves the machine.

**Version:** 0.3.3 | **Platform:** macOS 26 (Tahoe) or newer, Apple Silicon (arm64)

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                             │
│                                                                 │
│  ┌──────────────────────┐      ┌───────────────────────────┐   │
│  │   Renderer Process   │      │      Main Process         │   │
│  │   (React 19 + Vite)  │◄────►│  (Node.js / Electron API) │   │
│  │                      │ IPC  │                           │   │
│  │  AppShell + history  │      │  IPC handlers             │   │
│  │  TipTap editor       │      │  TaskQueueService         │   │
│  │  Tailwind CSS v4     │      │  better-sqlite3 (WAL)     │   │
│  └──────────────────────┘      │  electron-store           │   │
│                                │  TrayService              │   │
│         Preload Script         │  SourceFileCleanupService │   │
│   (Context Bridge / Zod IPC)   │  UpdateCheckService       │   │
│                                └──────────┬────────────────┘   │
└───────────────────────────────────────────│────────────────────┘
                                            │ spawns subprocesses
              ┌─────────────────────────────┼────────────────────┐
              │                             │                    │
              ▼                             ▼                    ▼
  ┌───────────────────┐       ┌─────────────────────┐  ┌──────────────────┐
  │  whisper.cpp CLI  │       │   Python Sidecar     │  │  Swift Vision    │
  │  (ASR subprocess) │       │  (pyannote.audio +   │  │  OCR CLI helper  │
  │                   │       │   flair NER)          │  │  (scanned PDFs)  │
  │  Whisper Large V3 │       │                      │  │                  │
  │  Turbo Q5_0       │       │  speaker-diarization  │  │  Apple Vision    │
  │  Metal GPU        │       │  -3.1 + alignment    │  │  Framework       │
  └───────────────────┘       │  flair/ner-german-   │  └──────────────────┘
                              │  large               │
                              └─────────────────────┘
```

All three subprocess types communicate with the Main Process only. The Renderer Process never has direct access to the filesystem or subprocesses.

---

## Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Framework | Electron 34 | Native macOS APIs, IPC security model, App Sandbox |
| UI | React 19 | Concurrent rendering, hooks-based state management |
| Build tooling | electron-vite 5 + Vite 6 | Fast HMR in dev, optimized production bundles per process |
| Styling | Tailwind CSS v4 (Vite plugin) | Zero-runtime, design tokens via CSS variables |
| Packaging | electron-builder 26 | DMG generation, Electron Fuses, arm64-only |
| Review Editor | TipTap 3 (ProseMirror) | Custom atomic node extensions for chips, speakers, timestamps |
| Storage (structured) | better-sqlite3 12 | Synchronous SQLite with WAL mode; sessions, tasks, blocklist |
| Storage (settings) | electron-store 11 | JSON-backed key-value store; theme, consent flag, update cache |
| IPC validation | Zod 4 | Schema validation on all IPC channels in both directions |
| TypeScript | 5.9, strict mode | Separate `tsconfig.node.json` + `tsconfig.web.json` per process |
| Testing | Vitest 3 + @testing-library/react | Globals enabled, jsdom environment |

---

## Process Model

| Process | Entry Point | Responsibility | ML Load |
|---|---|---|---|
| **Main** | `src/main/index.ts` | App lifecycle, window creation, CSP injection, SQLite database, task queue, IPC handler registration, tray, source-file cleanup and completion of interrupted deletions, update checks | None directly — orchestrates subprocess ML executors |
| **Preload** | `src/preload/index.ts` | Exposes typed `window.api` surface via `contextBridge`; all channels pass through Zod schema validation | None |
| **Renderer** | `src/renderer/src/main.tsx` | React UI — view navigation, recording controls, review editor, settings | None |
| **whisper.cpp subprocess** | `resources/bin/whisper-cli` | ASR: audio → raw transcript (RTTM/JSON). Runs Metal GPU acceleration. One instance at a time. | Whisper Large V3 Turbo Q5_0 (~0.6 GB) |
| **Python sidecar** | `python_sidecar/` | Speaker diarization (pyannote.audio), alignment, and NER anonymization (flair). Shared across pipeline stages. | pyannote speaker-diarization-3.1 (~0.06 GB) + flair/ner-german-large (~1.1 GB, fp16 on disk) |
| **Swift Vision OCR CLI** | `resources/bin/vision-ocr` | OCR for scanned PDF pages using Apple Vision Framework. Invoked per page only when pdfjs-dist finds no text. | Apple Vision (OS-provided, no model file) |

The task queue enforces strict sequential execution — only one ML executor runs at any given time, respecting the 8 GB RAM budget (~3.5 GB process peak during flair NER on 8-GB Macs).

---

## Filesystem Layout (`~/.therascript/`)

All application data lives under `~/.therascript/`. Directories are created with mode `0700` at startup by `initDatabase()`.

```
~/.therascript/
├── data/
│   └── therascript.db          # SQLite database (WAL mode): sessions, tasks, blocklist
├── audio/                      # Raw microphone recordings (.wav)
├── transcripts/                # Whisper output (.json)
├── anonymized/                 # Anonymized TipTap documents (.json)
├── diarization/                # Pyannote diarization output (.rttm / .json)
├── pdf/                        # Imported PDF files (copied on import)
├── extracted/                  # pdfjs-dist / Vision OCR extracted text (.json)
├── recovery/                   # Crash recovery snapshots
└── models/
    ├── asr/                    # Whisper model (~0.6 GB)
    │   └── ggml-large-v3-turbo-q5_0.bin
    ├── diarization/            # Pyannote model (~0.06 GB, HuggingFace cache format)
    └── ner/                    # flair/ner-german-large (~1.1 GB fp16; v1/v2 installs: 2.2 GB + 1.1 GB fp16 fast copy, 2.1 GB on the CPU path)
```

Models persist across app updates. Total disk requirement: ~3.4 GB (app ~1 GB + models ~2.4 GB incl. the search model under `search-embeddinggemma-2-text-v1/`), plus the search index in the database (up to ~0.6 GB at 2'000 sessions). First launch checks for 5 GB free to cover download + extraction (reasoning in `docs/product/features/model-management.md`, «Disk Space Check»).

---

## Build Tooling

The build configuration lives in `electron.vite.config.ts`:

```ts
// electron.vite.config.ts (simplified)
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['electron-store'] }  // must be bundled
    }
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@electron-toolkit/preload'] }  // must be bundled
    }
  },
  renderer: {
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') }
    },
    plugins: [react(), tailwindcss()]  // React + Tailwind CSS v4 Vite plugin
  }
})
```

Key details:
- **`@renderer` path alias** resolves to `src/renderer/src/` — used for all renderer-internal imports.
- `electron-store` and `@electron-toolkit/preload` are excluded from `externalizeDeps` so they are bundled into the output (they do not work as true externals in the Electron context).
- Tailwind CSS v4 is loaded as a Vite plugin (not a PostCSS plugin) — no `tailwind.config.js` needed.
- Electron Fuses are applied in `afterPack.js` after the build and re-signed with an ad-hoc signature (`codesign --sign -`) carrying the Designated Requirement `identifier "<bundle-id>"` (ADR-009).

---

## Navigation Model

Since Epic #192 the app has a **page history** with back/forward instead of a single view state — still without a router library. Everything lives in `src/renderer/src/navigation/`.

```ts
type Route =
  | { kind: 'sessions' }
  | { kind: 'dossiers' }                       // overview «Alle Patientendossiers» (#204)
  | { kind: 'dossier'; dossierId: string }     // page of one patient dossier (#204)
  | { kind: 'session'; sessionId: string; focus?: SessionFocus }
  | { kind: 'settings'; subpage: SubPage | null }
```

- `navReducer.ts` — pure history `{ back, current, forward }`, at most 50 entries, kept in memory only (#213 OOS 1). `navigate(route, { anchorId })` writes the anchor onto the entry being left, `{ targetAnchorId }` onto the new entry (#213: an unfinished «Zuletzt geöffnet» entry opens the sessions list with its card highlighted; on the same page it replaces the current entry with a fresh id so the page re-mounts and redeems the anchor); navigating to the same page creates no entry; `back`/`forward` skip invalid entries; `purge` removes entries of deleted objects and replaces the current one (dossier → overview, session → previous entry, otherwise the sessions list).
- `NavigationContext.tsx` — `useNavigation()` with `route`, `entryId`, `anchorId`, `canBack`, `canForward`, `navigate`, `back`, `forward`. Subscribes to `nav:command` (menu «Gehe zu»), `nav:openSettings` (app menu ⌘, and tray, always the Settings overview), `sessions:changed` and `dossiers:changed` (`deletedIds` → `purge`, #213 PC 3).
- `useScrollRestoration(ready)` — `PageScroll` is the shell's only scroll container and is keyed by `entryId`; it stores `scrollTop` per entry. Once a page's data is loaded, the position is restored and the card of `anchorId` (`data-session-id`, or `data-anchor-id` for other rows such as dossiers) is highlighted (scrolled into view only if hidden) — e.g. after closing a session (#205 AK 16).
- «Zuletzt geöffnet» (#213, `components/shell/RecentList.tsx`) sits below «Alle Patientendossiers» in the sidebar: at most eight dossiers, sessions and PDFs mixed, newest first, the running recording first with a pulsing dot. Each entry is a button with an icon whose accessible name is its kind («Patientendossier», «Sitzung», «PDF-Dokument») and the name — dossiers «Nachname, Vorname», sessions/PDFs their title in the chosen view (`sessionTitleIn`; no clear name in the pseudonymized view, also not in `title`/`aria-label`). A dossier or a processed session opens directly; anything else (recording, processing, error) navigates to the sessions list with `targetAnchorId`. `useRememberOpenedRoute()` in `AppShell` calls `recent:touch` on every dossier/session route — also with the sidebar hidden. The list reloads on `recent:changed`, `sessions:changed` and `dossiers:changed`; users cannot remove entries (OOS 2).
- The sidebar entry «Alle Patientendossiers» stays highlighted on a dossier page (`aria-current` only on the overview); its «+» and the overview button call `useWorkspaceActions().openNewDossier()`, which renders `NewDossierDialog` and navigates to the new dossier. Details: [patient-dossiers.md](../features/patient-dossiers.md) «User interface».

**Rendering:**

| Condition | What renders |
|---|---|
| `modelsReady === null` | Title bar (`minimal`) and an empty area |
| `modelsReady === false` | Title bar (`minimal`) + `FirstLaunchScreen` — no sidebar, no navigation |
| otherwise | `AppShell`: `TitleBar` (sidebar button, ‹ ›, wordmark, view toggle) above `Sidebar` + content column (banners, `RecordingBar`, `PageScroll` → `RouteView`) |
| route `sessions` | `SessionsPage` (`PageHeader` with «PDF importieren» / «Aufnahme starten», `ConsentBanner`, `SessionDashboard`) |
| route `session` | `ReviewEditor` (own header, scrolls internally; no close button — Esc, ‹ or ⌘[ go back) |
| route `settings` | `Settings` with the sub-page from the route |
| route `dossiers` | `DossiersPage` (heading with count and «Neues Patientendossier», name filter, list sorted by last name; empty state with instructions) |
| route `dossier` | `DossierPage` (`DossierHeader` + `DossierHeaderActions` with «PDF importieren» / «Aufnahme starten» into this dossier (#206) and the menu «…», `ConsentBanner` while its timeline shows the recording, `DossierTimeline` on the left (drop PDFs to import them into the dossier), `DossierMasterDataForm` with autosave on the right; wraps below ~800 px) |

**Navigation constraints:**
- The app stays fully navigable during recording; the sessions list and the page of every dossier the recording is assigned to show the live `RecordingSessionCard`, every other route the `RecordingBar`. Starting a recording navigates to the sessions list — except from a dossier page, which stays (#206).
- The sidebar can be hidden (title-bar button, ⌃⌘S); the state is stored as `sidebarOpen` in electron-store and read synchronously by the preload before the first render.
- The app stays alive in the macOS menu bar when the window is closed (standard macOS behavior via `TrayService`).
- Quitting the app (not closing the window, which only hides it) first asks the renderer to save pending edits (`app:flushPendingEdits`, at most 3 s, `src/main/services/PendingEditsFlush.ts`; renderer registry `src/renderer/src/services/pendingEdits.ts` with the dossier drafts and the review editor), then closes the database and, if due, swaps in the update.
- Lists reload on the bundled main-process event `sessions:changed` (`src/main/services/ChangeEvents.ts`) via `hooks/useLiveQuery`.
- Updates (app and models as one, #167) show as «Update bereit» / «Update verfügbar» in the sidebar footer, which opens Settings → Updates; installing restarts the app once.
