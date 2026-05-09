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
│  │  App.tsx (view state)│      │  IPC handlers             │   │
│  │  TipTap editor       │      │  TaskQueueService         │   │
│  │  Tailwind CSS v4     │      │  better-sqlite3 (WAL)     │   │
│  └──────────────────────┘      │  electron-store           │   │
│                                │  TrayService              │   │
│         Preload Script         │  AutoDeletionService      │   │
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
| **Main** | `src/main/index.ts` | App lifecycle, window creation, CSP injection, SQLite database, task queue, IPC handler registration, tray, auto-deletion, update checks | None directly — orchestrates subprocess ML executors |
| **Preload** | `src/preload/index.ts` | Exposes typed `window.api` surface via `contextBridge`; all channels pass through Zod schema validation | None |
| **Renderer** | `src/renderer/src/main.tsx` | React UI — view navigation, recording controls, review editor, settings | None |
| **whisper.cpp subprocess** | `resources/bin/whisper-cli` | ASR: audio → raw transcript (RTTM/JSON). Runs Metal GPU acceleration. One instance at a time. | Whisper Large V3 Turbo Q5_0 (~1.7 GB) |
| **Python sidecar** | `python_sidecar/` | Speaker diarization (pyannote.audio), alignment, and NER anonymization (flair). Shared across pipeline stages. | pyannote speaker-diarization-3.1 (~0.2 GB) + flair/ner-german-large (~2.2 GB) |
| **Swift Vision OCR CLI** | `resources/bin/vision-ocr` | OCR for scanned PDF pages using Apple Vision Framework. Invoked per page only when pdfjs-dist finds no text. | Apple Vision (OS-provided, no model file) |

The task queue enforces strict sequential execution — only one ML executor runs at any given time, respecting the 8 GB RAM budget (~5.2 GB peak during flair NER).

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
    ├── asr/                    # Whisper model (~1.7 GB)
    │   └── ggml-large-v3-turbo-q5_0.bin
    ├── diarization/            # Pyannote model (~0.2 GB, HuggingFace cache format)
    └── ner/                    # flair/ner-german-large (~2.2 GB)
```

Models persist across app updates. Total disk requirement: ~4.1 GB for models + app.

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
- Electron Fuses are applied in `afterPack.js` after the build and re-signed with an ad-hoc signature (`codesign --sign -`).

---

## Navigation Model

Therascript does not use a client-side router. Navigation is managed via a single `View` state in `App.tsx`:

```ts
type View = 'sessions' | 'settings' | 'review'
```

**Rendering logic (priority order):**

| Condition | What renders |
|---|---|
| `modelsReady === null` | Empty loading screen (transparent, no flash) |
| `modelsReady === false` | `FirstLaunchScreen` — model download wizard |
| `pendingUpdates !== null` | `ModelUpdateScreen` — applies staged model updates |
| `isRecording === true` | `RecordingView` overlays the main content area |
| `currentView === 'review'` | `ReviewEditor` (full-screen, own header) |
| `currentView === 'sessions'` | `SessionDashboard` |
| `currentView === 'settings'` | `Settings` (tabbed: Sperrliste / Darstellung / Modelle / Über) |

**Navigation constraints:**
- Sidebar navigation (Sitzungen / Einstellungen) is disabled during recording and during review.
- `UpdateBanner` overlays the top of the app (non-blocking) when new model versions are available after a background update check.
- The app stays alive in the macOS menu bar when the window is closed (standard macOS behavior via `TrayService`).
- App update availability shows as a sidebar link that opens GitHub Releases in the default browser.
