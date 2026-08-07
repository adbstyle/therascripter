# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shell Commands

- Never put `#` comments inside Bash tool calls — write explanations as plain text before the tool call instead. Comments at the start of a command block break allow-list pattern matching.

## Project Summary

Therascript is an Electron-based macOS desktop app for local therapy session transcription and anonymization. All processing happens on-device (no cloud). German + Swiss-German dialect support. Targets Apple Silicon Macs (M1-M4). The currently shipped builds require macOS 26 (Tahoe) or newer because the bundled `libggml-metal.0.dylib` (whisper.cpp Metal backend, copied from the Homebrew `whisper-cpp` bottle by `scripts/setup-whisper.sh` on a macOS-26 host) is linked against the macOS-26 SDK with `minos 26.0` and references the `MTLResidencySetDescriptor` symbol. Lowering the floor is tracked as Issue #97. Pyannote is NOT the cause — the Python sidecar does not depend on `libggml-metal`.

Key docs: `docs/product/` (living product documentation — architecture, features, operations, ADRs). Historical planning docs archived in `docs/archive/`.

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
scripts/setup-pyannote.sh                # Create Python venv with pyannote.audio → python_sidecar/venv/
scripts/setup-pyannote.sh --model        # Also download speaker-diarization-3.1
scripts/setup-pyannote.sh --model-community  # Also download speaker-diarization-community-1 (gated — requires HF terms-accept)
scripts/setup-pyannote.sh --all-models   # Download both
scripts/setup-ner.sh              # Install flair into existing Python venv
scripts/setup-ner.sh --model      # Also download NER model (~1.1 GB)
scripts/setup-vision-ocr.sh       # Build Swift Vision OCR CLI helper → resources/bin/
scripts/setup-ffmpeg.sh            # Install static ARM64 ffmpeg → resources/bin/ (required for pipeline inversion / ADR-007)
scripts/setup-llama.sh             # Install llama.cpp via Homebrew → resources/bin/ + resources/lib/
scripts/setup-llama.sh --model     # Also download Gemma 3 4B Instruct Q4_K_M (~2.5 GB, gated — needs huggingface-cli login)
npm run sidecar:build              # Build standalone Python sidecar via uv → python_sidecar/standalone/
npm run sidecar:package            # Package models for R2 upload
npm run sidecar:upload             # Upload model packages to Cloudflare R2
npm run sidecar:deploy             # Build + package + upload (full pipeline)
scripts/publish-manifest.sh       # Generate manifest.json from r2-upload/ + upload to R2 (run after sidecar:package)
scripts/sim-clean-install.sh       # Simulate fresh / upgrade / models-only install (interactive); --status, --restore
```

## Architecture

**Build tooling:** electron-vite (Vite-based) with React plugin + Tailwind CSS v4 plugin.

**Three Electron processes:**
- **Main** (`src/main/`) — App lifecycle, window creation, CSP injection, IPC handlers. Security-hardened: navigation blocked, popups denied, sandbox enabled.
- **Preload** (`src/preload/`) — Context bridge exposing APIs to renderer. All IPC channels use Zod schema validation (schemas in `src/shared/validation/`).
- **Renderer** (`src/renderer/`) — React 19 + Tailwind CSS UI. Path alias: `@renderer` → `src/renderer/src`.

**Shared** (`src/shared/`) — Types and Zod validation schemas used by both main and renderer processes.

**ML pipeline — Audio** (strictly sequential, one model at a time, **diarization-first since Issue #78 / ADR-007**):
1. Python sidecar — pyannote.audio diarization via auswählbares Modell aus Katalog (Default: `speaker-diarization-3.1`; optional: `speaker-diarization-community-1` für bessere Deutsch-Performance). Active model stored in electron-store (`activeModels.diarization`), verwaltet via Settings → Modelle. HF_HUB_OFFLINE=1 erzwingt lokale Cache-Nutzung. ✓ implemented
2. ffmpeg — Stitch aller Pyannote-Speech-Segmente mit ±200 ms Padding zu einer kontinuierlichen WAV (`AudioStitchService`). Implicit step within whisper executor; eliminates silence from whisper input → strukturell halluzinations-frei. ✓ implemented
3. whisper.cpp subprocess — ASR auf der gestitchten WAV (single subprocess call) via auswählbares Modell aus Katalog (Default: Whisper Large V3 Turbo Q5_0 multilingual; optional: Swiss-German-Fine-Tune). Output-Timestamps werden über persistierte StitchMap (`src/main/ml/timestamp-remap.ts`) auf Original-Wall-Clock zurückgemappt. Active model stored in electron-store (`activeModels.transcription`), verwaltet via Settings → Modelle. ✓ implemented
4. Python sidecar — flair NER (flair/ner-german-large) + Regex + Blocklist → TipTap document ✓ implemented
5. llama.cpp subprocess — optionale Zusammenfassung über auswählbares Modell aus Katalog (Default: Gemma 3 4B Instruct Q4_K_M GGUF). Registriert als letzter Schritt beider Pipeline-Chains (Audio + PDF). Wenn Modell nicht installiert → Executor skippt den Step geräuschlos, Summary bleibt NULL. Active model in electron-store (`activeModels.summarization`), verwaltet via Settings → Modelle. Anders als ASR/Diarization darf der aktive Summarization-Slot leer sein (deaktivieren + löschen erlaubt → Pipeline skippt den Step). ✓ implemented

**ML pipeline — PDF** (extraction → ocr → anonymization → summarization):
1. pdfjs-dist — Text extraction per page (with `standardFontDataUrl` configured) ✓ implemented
2. Swift CLI helper — Apple Vision OCR for scanned pages (skipped if all text) ✓ implemented
3. Python sidecar — flair NER + Regex + Blocklist → TipTap document (shared with audio) ✓ implemented
4. llama.cpp subprocess — optional summarization (shared with audio). ✓ implemented

**ML models:** Stored in `~/.therascript/models/<type>/` (e.g. `models/asr/`, `models/diarization/`, `models/ner/`). Required-group dirs are bootstrapped at startup by `initDatabase()`; optional-group dirs (e.g. `models/summarization/`) are created on-demand by `downloadSingleModel` — only existing once the user actually downloads an optional model.

**First launch:** FirstLaunchScreen checks for models, validates disk space (5 GB minimum), downloads ~4.1 GB (Whisper 1.7 GB + Pyannote 0.2 GB + flair NER 2.2 GB) with progress tracking. Models persist across app updates.

**Python sidecar:** Two modes: (1) **Dev**: Python venv at `python_sidecar/venv/` — one-time setup after fresh clone: `scripts/setup-pyannote.sh --model` then `scripts/setup-ner.sh --model`. (2) **Production**: Standalone relocatable Python at `python_sidecar/standalone/` built via `uv` (no PyInstaller, no hidden import issues). Build with `npm run sidecar:build`. The torchcodec shim (`torchcodec_shim.py`) is loaded via `sitecustomize.py` in the standalone environment. Pyannote requires HuggingFace token (`huggingface-cli login`) and accepted terms for `pyannote/speaker-diarization-3.1` + `pyannote/speaker-diarization-community-1`. The venv and models persist across builds — no re-setup needed for `npm run dev/build`.

**Review Editor extensions:** 3 custom TipTap node extensions in `src/renderer/src/extensions/` — `placeholderChip` (anonymized entity chips), `speakerLabel` (speaker diarization labels), `timestamp` (time markers). Corresponding NodeViews in `components/editor/`.

**Storage:** better-sqlite3 (sessions, blocklist) + electron-store (settings).

**System tray:** TrayService provides macOS menu bar icon with stop-recording action. App keeps running in background when window is closed.

**PDF import:** Drag-and-drop or button in SessionDashboard. Files copied to `~/.therascript/pdf/`. Import guard prevents duplicate imports. Copy failure triggers session rollback. Orphaned sessions (stuck in processing with no tasks) are recovered at startup.

**UI navigation:** Simple view state (`'sessions' | 'settings' | 'review'`) in App.tsx — no router. Persistent shell components live in `src/renderer/src/components/shell/`: `TitleBar` (centered wordmark, hiddenInset drag region) and `BottomNav` (chip-style nav, replaces the earlier sidebar). Both hide during recording and review. The Sessions view header is labeled "Transkriptionen" in UI copy (data model term remains "session"). First-launch screen is shown conditionally via `modelsReady` state (not a view). `ModelUpdateScreen` is shown when pending model updates exist after restart (`pendingUpdates` state). `UpdateBanner` overlays the main app when new model versions are available (non-blocking). Settings view uses a master-detail pattern: a list of section cards (Sperrliste/Darstellung/Modelle/Über) drills into per-section sub-pages with a back link. Review editor opened by clicking a session card in `review` status. Navigation disabled during recording and review. First-launch screen shown when models are not yet downloaded.

**Theme system:** `ThemeContext` + `ThemeProvider` (`src/renderer/src/contexts/ThemeContext.tsx`) manage light/dark/system preference, persisted via electron-store. `createWindow()` reads `nativeTheme` to set `backgroundColor` on the `BrowserWindow` (prevents white flash in dark mode). `AppearanceSettings.tsx` renders the user-facing toggle in the Darstellung sub-page.

**ConsentBanner:** Shown inside `RecordingView` on first recording — one-time reminder to obtain patient consent. State tracked via electron-store (`consentReminderShown`).

**Icons:** `lucide-react` for all UI icons. Direct named imports (`import { Mic } from 'lucide-react'`) — tree-shakeable. Sizing via Tailwind (`h-4 w-4` inline, `h-5 w-5` standalone, `h-7 w-7` settings cards). Color via `currentColor` / Tailwind text utilities (`text-text-tertiary`, `text-primary`, etc.). `strokeWidth` should match the visual weight of surrounding text — typical values: `1.5` for large decorative icons (`h-7`, Settings cards), `1.75` for header/card icons sitting next to bold text (`h-5`), `2` for inline UI alongside a text label, `2.5` for success-checkmark emphasis. Always `aria-hidden` when decorative. **Never** use emojis as icons or hand-roll inline SVGs for new UI — exception: `AppLogo.tsx` (brand mark with multi-color paths, not a generic icon).

**Update System (Iteration 17+18):** `UpdateCheckService` checks R2 manifest for newer model versions and app updates in a single fetch. Model updates download atomically into a staging directory and swap on restart. App updates show a non-blocking sidebar hint + About page button that opens GitHub Releases. `model-update-handlers.ts` exposes model update IPC channels; `app-update-handlers.ts` exposes `appUpdate.getStatus()`, `appUpdate.check()`, `appUpdate.openReleasePage()`. Cached app update status persisted in electron-store.

**Key constraints:**
- 8 GB minimum RAM budget (~5.2 GB peak during flair NER)
- Production CSP: `connect-src 'none'` (zero network access)
- Context isolation + sandbox always enabled
- All ML models must be swappable (plugin architecture, NFR-9/10)
- Electron Fuses hardened at build time (RunAsNode disabled, OnlyLoadAppFromAsar, cookie encryption)
- FileVault check at startup — warns user if disk encryption is not enabled

## Gotchas

- **whisper.cpp und llama.cpp linken gegen inkompatible ggml-Generationen.** Homebrew's `whisper-cpp` baut gegen ggml ~0.9.x, `llama.cpp` gegen ggml ~0.10+/0.12+. Beide Binaries bundlen via `LC_RPATH=@loader_path/../lib`. Sie liegen deshalb in **getrennten Self-Contained-Bundles** unter `resources/whisper/{bin,lib}/` und `resources/llama/{bin,lib}/` — jedes Tool lädt seine eigene libggml-Version. Nie auf eine gemeinsame `resources/lib/` zurückgehen: das zweite Setup-Skript würde die libggml-Generation des ersten überschreiben und das ältere Binary crasht beim Modell-Init in `make_buft_list` (ABI-Mismatch, `exit code null` via Native-Signal). Für **DMG-Portabilität auf Endnutzer-Macs ohne Homebrew** ist das Setup deutlich invasiver als ein simpler `cp`: (a) jeder bundled Mach-O wird via `install_name_tool` auf `@rpath` umgeschrieben (eigener Helper `rewrite_macho` in beiden Skripten — scant `otool -L`-Output und rewrited jede absolute `/opt/homebrew`-Ref), (b) `libssl.3.dylib` + `libcrypto.3.dylib` aus `openssl@3` werden in das llama-Bundle mitkopiert (transitive Dep von `libllama-common`; macOS hat kein system-libssl mehr), (c) ggml 0.10+ verwendet eine Plugin-Architektur — `libggml.0.dylib` macht zur Laufzeit `dlopen` auf separate Backend-`.so` Files (Metal/BLAS/CPU-Variante pro Apple-Silicon-Generation). Die Plugins werden aus `$(brew --prefix ggml)/libexec/*.so` ins llama-Bundle mitkopiert; (d) `libggml-cpu-apple_m*.so` linkt `libomp.dylib` → auch gebundlet. (e) libggml hat einen **hardcoded fallback** Backend-Suchpfad `/opt/homebrew/Cellar/ggml/<ver>/libexec` der auf Endnutzer-Macs nicht existiert → `LlamaSummarizer.ts` setzt beim Spawnen `GGML_BACKEND_PATH=<bundle>/lib` als Override. Alle `install_name_tool`-Aufrufe laufen **vor** dem ad-hoc-codesign-Schritt, damit der re-sign die modifizierten Mach-Os mit-deckt. `scripts/verify-bundles.sh` prüft als CI-Smoke, dass beide Bundles null `/opt/homebrew`-Refs enthalten und alle Plugins vorhanden sind. ffmpeg + vision-ocr bleiben in `resources/bin/` (keine shared deps, nur System-Frameworks). Vollständiger Plan: [docs/plans/ggml-abi-split.md](docs/plans/ggml-abi-split.md).
- **better-sqlite3 native rebuild:** `postinstall` and `predev` run `electron-rebuild` (for Electron ABI), while `pretest`/`pretest:watch` run `npm rebuild` (for system Node.js ABI). The `package` script runs `electron-rebuild` explicitly before building; `npmRebuild: false` in `electron-builder.yml` prevents electron-builder's own unreliable rebuild. If native module errors occur, run `npm run postinstall` manually.
- **`npm test` requires Xcode Command-Line Tools:** the `pretest`/`pretest:watch` hook calls `npm rebuild better-sqlite3` against the system Node ABI. On a fresh Mac without Xcode CLT, this fails with `gyp: No Xcode or CLT version detected!`. Fix: install once with `xcode-select --install`. Workaround if you can't install CLT but want to run tests: `npx vitest run <path>` skips the pretest hook entirely — fine for tests that don't touch SQLite (e.g. pure modules like `timestamp-remap`, `AudioStitchService.computeStitchMap`, `ProcessWatchdog`). Tests using `getDatabase()` need the rebuilt native binding to load.
- **`env -u ELECTRON_RUN_AS_NODE`:** The `dev` script unsets this env var because Electron Fuses disable RunAsNode — without this workaround, `electron-vite dev` fails.
- **`.env` file:** Contains Cloudflare R2 credentials for model uploads. Gitignored — never commit.
- **Vitest setup:** Requires `tests/setup.ts` (jsdom environment). Referenced in `vitest.config.ts`.
- **Code signing:** No Apple Developer account — `identity: null` in `electron-builder.yml` disables electron-builder signing. `afterPack.js` flips Electron Fuses and must use `resetAdHocDarwinSignature: true` to re-sign with ad-hoc signature (`codesign --sign -`). Without this, ARM64 macOS kills the app on launch (`CODESIGNING, Code 2 Invalid Page`). Users must right-click → Open on first launch.
- **electron-vite externals:** `electron-store` (main) and `@electron-toolkit/preload` (preload) are excluded from `externalizeDeps` in `electron.vite.config.ts` — they must be bundled, not externalized.
- **Model hash sync:** After `npm run sidecar:deploy` or `scripts/publish-manifest.sh`, the SHA-256 hashes in `ModelDownloadService.ts` `MODEL_DEFINITIONS` must be manually updated to match `manifest.json`. The packaging scripts print hashes to stdout but don't auto-update the source. Stale hashes cause first-launch download failures.
- **Standalone Python sidecar:** Built via `uv` with python-build-standalone (~1 GB). All `.dylib`/`.so` files are ad-hoc codesigned during build. If the sidecar fails to run, try `scripts/build-sidecar.sh --clean` for a fresh build. The `torchcodec_shim.py` provides a soundfile-based fallback for torchcodec (required by pyannote.audio 4.0.4+), loaded automatically via `sitecustomize.py`. **Important:** `requirements.txt` + `requirements-ner.txt` are the sole dependency source — any Python package needed at runtime (including transitive deps like `soundfile`) must be listed explicitly, unlike the old PyInstaller build which had hidden imports.
- **Gemma 4 E4B GGUF source:** No official Google GGUF for Gemma 4 E4B existed when the summarization feature shipped. Default catalog entry uses bartowski's Gemma 3 4B Instruct Q4_K_M as fallback. The repo is HuggingFace-gated — `huggingface-cli login` is required before `scripts/setup-llama.sh --model`. If/when a Gemma 4 E4B GGUF lands upstream, swap the URL/filename in `MODEL_DEFINITIONS` and re-run `scripts/publish-manifest.sh` to mirror into R2.
- **llama-cli stall threshold:** `LlamaSummarizer.summarize()` provides no fine-grained progress callbacks (single subprocess call returning final stdout). The TaskQueue's `ProcessWatchdog` defaults to 120s for unrecognized task types — for a 4B model this is generous on M-series hardware (typical inference ~5-30s) but tight if the user's box is loaded. If summarization tasks start failing with "Verarbeitung reagiert nicht mehr", add a `summarization: 600_000` entry to `STALL_THRESHOLDS` in `ProcessWatchdog.ts`.
- **Summarization output is JSON-Schema-driven, not regex-parsed.** `LlamaSummarizer` passes `--json-schema` to llama-cli; the grammar engine constrains token sampling so the model can ONLY emit `{title, summary}` objects matching the schema. Output shape is defined ONCE in `src/main/ml/summarization-schema.ts` (Zod validator + JSON Schema string side-by-side, kept in sync by a unit test). Do not edit the prompt to demand format — the schema does that. Do not parse stdout with line-anchored regexes — llama-cli's spinner ASCII (`\r`-overwrites like `|-\|/-\|/`) prefixes the model's output line in non-terminal stdout capture and breaks anchored regexes; we now `extractFirstJSONObject(stdout)` + `JSON.parse` + Zod-validate.
- **Summarization is OPTIONAL and graceful-skip on any failure.** `SummarizationExecutor` wraps `summarize()` in try/catch and logs + returns cleanly on ANY error (subprocess crash, abort, JSON-extraction failure, schema-validation failure, transient model error). Sessions reach `'review'` regardless of LLM success — `sessions.summary` simply stays `NULL`. Do NOT propagate summarization errors to the TaskQueue: that would set `session.status='error'` and hide the already-anonymized transcript behind a Retry button.
- **Whisper hallucinations on silence are structurally prevented (ADR-007, supersedes ADR-006).** Whisper läuft NICHT mehr auf der vollen WAV, sondern nur auf einer von `AudioStitchService` (`src/main/services/AudioStitchService.ts`) aus den Pyannote-Speech-Segmenten gestitchten WAV mit ±200 ms Padding. Stille-Phasen sind dadurch für Whisper unsichtbar — Halluzinationen wie "Vertraue und glaube, es hilft, es heilt die göttliche Kraft!" oder "Untertitelung des ZDF, 2020" können strukturell nicht mehr entstehen. Output-Timestamps werden über die persistierte `StitchMap` (`src/shared/types/StitchMap.ts`) auf Original-Wall-Clock zurückgemappt, bevor `AlignmentService` läuft — siehe `remapStitchedTimestamp` in `src/main/ml/timestamp-remap.ts`. **Defense in depth:** `-mc 0` (`--max-context 0`) bleibt im `whisper-cli`-Aufruf erhalten und schützt die verbleibenden Speech-Segmente vor Inter-Window-Loops. **Wichtig:** Verwende **nicht** `-nc` / `--no-context` — modernes whisper.cpp lehnt diese Flags ab und exitet **0**, was sich als generischer "no JSON output"-Pfad maskiert. Der exakte Args-Satz ist in `buildWhisperArgs()` (`WhisperService.ts`) und ein Snapshot-Test (`WhisperService.test.ts`) gelockt. Pipeline-Reihenfolge ist single-source-of-truth: backend (`TaskQueueService`) und frontend (`SessionCard`) importieren beide aus `src/shared/constants/pipeline.ts`; ein Snapshot-Test (`src/shared/__tests__/pipeline-order.test.ts`) verhindert lokale Duplikate.
- **Empty-speech recordings reach `review`, not `error`.** Wenn Pyannote auf eine Aufnahme 0 Speech-Segmente meldet (z. B. nur Stille / vergessenes Mikro), produziert `WhisperService` ein leeres `TranscriptData`. `AlignmentService` und `AnonymizationService` haben einen Empty-Path-Shortcut: leeres aligned-Transkript bzw. minimales TipTap-Doc `{type: 'doc', content: [{type: 'paragraph'}]}` — die Session erreicht regulär den Review-Editor. Erfolgskriterium #2 in Issue #78. Achtung beim Editieren der beiden Services: bei leerem Input NICHT throwen, sonst landet die Session in `'error'`-State.

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
