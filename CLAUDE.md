# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shell Commands

- Never put `#` comments inside Bash tool calls — write explanations as plain text before the tool call instead. Comments at the start of a command block break allow-list pattern matching.

## Project Summary

Therascript is an Electron-based macOS desktop app for local therapy session transcription and anonymization. All processing happens on-device (no cloud). German + Swiss-German dialect support. Targets Apple Silicon Macs (M1-M4), macOS 14+.

Key documents: `requirements.md` (user stories, NFRs, decisions), `specification.md` (architecture, ML pipeline, data model), `implementation-plan.md` (iteration roadmap), `wireframes.md` (24 screens + UX flows).

## Commands

```bash
npm run dev           # Start Electron app with Vite HMR
npm run build         # TypeCheck + electron-vite build
npm run test          # Run all tests (vitest, single run)
npm run test:watch    # Run tests in watch mode
vitest run src/path/to/file.test.ts  # Run a single test file
npm run lint          # ESLint with cache
npm run format        # Prettier formatting
npm run typecheck     # TypeScript check (both node + web configs)
npm run start         # Preview production build (electron-vite preview)
npm run package       # electron-rebuild + build + electron-builder → macOS DMG (arm64 only)
scripts/release.sh                # Interactive version bump → DMG build → GitHub release (via gh CLI)
scripts/setup-whisper.sh          # Install whisper-cli via Homebrew → resources/bin/ + resources/lib/
scripts/setup-whisper.sh --model  # Also download ASR model (~547 MB)
scripts/setup-pyannote.sh         # Create Python venv with pyannote.audio → python_sidecar/venv/
scripts/setup-pyannote.sh --model # Also download diarization model
scripts/setup-ner.sh              # Install flair into existing Python venv
scripts/setup-ner.sh --model      # Also download NER model (~1.1 GB)
scripts/setup-vision-ocr.sh       # Build Swift Vision OCR CLI helper → resources/bin/
npm run sidecar:build              # Build standalone Python sidecar via uv → python_sidecar/standalone/
npm run sidecar:package            # Package models for R2 upload
npm run sidecar:upload             # Upload model packages to Cloudflare R2
npm run sidecar:deploy             # Build + package + upload (full pipeline)
scripts/publish-manifest.sh       # Generate manifest.json from r2-upload/ + upload to R2 (run after sidecar:package)
```

## Architecture

**Build tooling:** electron-vite (Vite-based) with React plugin + Tailwind CSS v4 plugin.

**Three Electron processes:**
- **Main** (`src/main/`) — App lifecycle, window creation, CSP injection, IPC handlers. Security-hardened: navigation blocked, popups denied, sandbox enabled.
- **Preload** (`src/preload/`) — Context bridge exposing APIs to renderer. All IPC channels use Zod schema validation (schemas in `src/shared/validation/`).
- **Renderer** (`src/renderer/`) — React 19 + Tailwind CSS UI. Path alias: `@renderer` → `src/renderer/src`.

**Shared** (`src/shared/`) — Types and Zod validation schemas used by both main and renderer processes.

**ML pipeline — Audio** (strictly sequential, one model at a time):
1. whisper.cpp subprocess — ASR (Whisper Large V3 Turbo Q5_0, Metal GPU) ✓ implemented
2. Python sidecar — pyannote.audio diarization (speaker-diarization-3.1) + alignment ✓ implemented
3. Python sidecar — flair NER (flair/ner-german-large) + Regex + Blocklist → TipTap document ✓ implemented

**ML pipeline — PDF** (extraction → ocr → anonymization):
1. pdfjs-dist — Text extraction per page (with `standardFontDataUrl` configured) ✓ implemented
2. Swift CLI helper — Apple Vision OCR for scanned pages (skipped if all text) ✓ implemented
3. Python sidecar — flair NER + Regex + Blocklist → TipTap document (shared with audio) ✓ implemented

**ML models:** Stored in `~/.therascript/models/<type>/` (e.g. `models/asr/`, `models/diarization/`, `models/ner/`). Directories created at startup by `initDatabase()`.

**First launch:** FirstLaunchScreen checks for models, validates disk space (5 GB minimum), downloads ~4.1 GB (Whisper 1.7 GB + Pyannote 0.2 GB + flair NER 2.2 GB) with progress tracking. Models persist across app updates.

**Python sidecar:** Two modes: (1) **Dev**: Python venv at `python_sidecar/venv/` — one-time setup after fresh clone: `scripts/setup-pyannote.sh --model` then `scripts/setup-ner.sh --model`. (2) **Production**: Standalone relocatable Python at `python_sidecar/standalone/` built via `uv` (no PyInstaller, no hidden import issues). Build with `npm run sidecar:build`. The torchcodec shim (`torchcodec_shim.py`) is loaded via `sitecustomize.py` in the standalone environment. Pyannote requires HuggingFace token (`huggingface-cli login`) and accepted terms for `pyannote/speaker-diarization-3.1` + `pyannote/speaker-diarization-community-1`. The venv and models persist across builds — no re-setup needed for `npm run dev/build`.

**Review Editor extensions:** 3 custom TipTap node extensions in `src/renderer/src/extensions/` — `placeholderChip` (anonymized entity chips), `speakerLabel` (speaker diarization labels), `timestamp` (time markers). Corresponding NodeViews in `components/editor/`.

**Storage:** better-sqlite3 (sessions, blocklist) + electron-store (settings).

**System tray:** TrayService provides macOS menu bar icon with stop-recording action. App keeps running in background when window is closed.

**PDF import:** Drag-and-drop or button in SessionDashboard. Files copied to `~/.therascript/pdf/`. Import guard prevents duplicate imports. Copy failure triggers session rollback. Orphaned sessions (stuck in processing with no tasks) are recovered at startup.

**UI navigation:** Simple view state (`'sessions' | 'settings' | 'review'`) in App.tsx — no router. First-launch screen is shown conditionally via `modelsReady` state (not a view). `ModelUpdateScreen` is shown when pending model updates exist after restart (`pendingUpdates` state). `UpdateBanner` overlays the main app when new model versions are available (non-blocking). Settings view has tabbed layout (Sperrliste/Darstellung/Modelle/Über). Review editor opened by clicking a session card in `review` status. Navigation disabled during recording and review. First-launch screen shown when models are not yet downloaded.

**Theme system:** `ThemeContext` + `ThemeProvider` (`src/renderer/src/contexts/ThemeContext.tsx`) manage light/dark/system preference, persisted via electron-store. `createWindow()` reads `nativeTheme` to set `backgroundColor` on the `BrowserWindow` (prevents white flash in dark mode). `AppearanceSettings.tsx` renders the user-facing toggle in the Darstellung tab.

**ConsentBanner:** Shown inside `RecordingView` on first recording — one-time reminder to obtain patient consent. State tracked via electron-store (`consentReminderShown`).

**Update System (Iteration 17+18):** `UpdateCheckService` checks R2 manifest for newer model versions and app updates in a single fetch. Model updates download atomically into a staging directory and swap on restart. App updates show a non-blocking sidebar hint + About page button that opens GitHub Releases. `model-update-handlers.ts` exposes model update IPC channels; `app-update-handlers.ts` exposes `appUpdate.getStatus()`, `appUpdate.check()`, `appUpdate.openReleasePage()`. Cached app update status persisted in electron-store.

**Key constraints:**
- 8 GB minimum RAM budget (~5.2 GB peak during flair NER)
- Production CSP: `connect-src 'none'` (zero network access)
- Context isolation + sandbox always enabled
- All ML models must be swappable (plugin architecture, NFR-9/10)
- Electron Fuses hardened at build time (RunAsNode disabled, OnlyLoadAppFromAsar, cookie encryption)
- FileVault check at startup — warns user if disk encryption is not enabled

## Gotchas

- **better-sqlite3 native rebuild:** `postinstall` and `predev` run `electron-rebuild` (for Electron ABI), while `pretest`/`pretest:watch` run `npm rebuild` (for system Node.js ABI). The `package` script runs `electron-rebuild` explicitly before building; `npmRebuild: false` in `electron-builder.yml` prevents electron-builder's own unreliable rebuild. If native module errors occur, run `npm run postinstall` manually.
- **`env -u ELECTRON_RUN_AS_NODE`:** The `dev` script unsets this env var because Electron Fuses disable RunAsNode — without this workaround, `electron-vite dev` fails.
- **`.env` file:** Contains Cloudflare R2 credentials for model uploads. Gitignored — never commit.
- **Vitest setup:** Requires `tests/setup.ts` (jsdom environment). Referenced in `vitest.config.ts`.
- **Code signing:** No Apple Developer account — `identity: null` in `electron-builder.yml` disables electron-builder signing. `afterPack.js` flips Electron Fuses and must use `resetAdHocDarwinSignature: true` to re-sign with ad-hoc signature (`codesign --sign -`). Without this, ARM64 macOS kills the app on launch (`CODESIGNING, Code 2 Invalid Page`). Users must right-click → Open on first launch.
- **electron-vite externals:** `electron-store` (main) and `@electron-toolkit/preload` (preload) are excluded from `externalizeDeps` in `electron.vite.config.ts` — they must be bundled, not externalized.
- **Standalone Python sidecar:** Built via `uv` with python-build-standalone (~1 GB). All `.dylib`/`.so` files are ad-hoc codesigned during build. If the sidecar fails to run, try `scripts/build-sidecar.sh --clean` for a fresh build. The `torchcodec_shim.py` provides a soundfile-based fallback for torchcodec (required by pyannote.audio 4.0.4+), loaded automatically via `sitecustomize.py`. **Important:** `requirements.txt` + `requirements-ner.txt` are the sole dependency source — any Python package needed at runtime (including transitive deps like `soundfile`) must be listed explicitly, unlike the old PyInstaller build which had hidden imports.

## Code Conventions

- **Formatting:** Prettier — no semicolons, single quotes, no trailing commas, 100 char line width, 2-space indent
- **Unused vars:** Prefix with `_` (ESLint `@typescript-eslint/no-unused-vars` with `^_` pattern)
- **TypeScript:** Strict mode, separate configs for node (`tsconfig.node.json`) and web (`tsconfig.web.json`)
- **Testing:** Vitest + @testing-library/react + jsdom. Globals enabled (no imports needed for describe/it/expect). Test files: `*.{test,spec}.{ts,tsx}` anywhere in `src/`
- **Window chrome:** macOS `hiddenInset` title bar with custom drag regions (`.titlebar-drag` / `.titlebar-no-drag` CSS classes)

## Domain-Specific Rules

- **Sperrliste (blocklist):** 7 user-visible entity types, bidirectional Umlaut normalization, longest-match-first replacement. CRUD via Settings UI ✓ implemented
- **Placeholder format:** `[PERSON 1]`, `[ORT 1]`, etc. — numeric, type-specific
- **flair ORG entities:** Ignored (institutions only via Sperrliste/manual)
- **Auto-deletion:** Sessions deleted 30 days after creation, silent
- **Auto-stop recording:** 2 hours max
- **Clipboard export:** Anonymized text can be exported to clipboard from Review Editor (toast confirmation)
- **Quick-add to Sperrliste:** Selected text in Review Editor can be added to blocklist with retroactive re-anonymization
- **Password-protected PDFs:** Not supported
