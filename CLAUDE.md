# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
npm run package       # Build + electron-builder → macOS DMG (arm64 only)
scripts/setup-whisper.sh          # Install whisper-cli via Homebrew → resources/bin/ + resources/lib/
scripts/setup-whisper.sh --model  # Also download ASR model (~547 MB)
scripts/setup-pyannote.sh         # Create Python venv with pyannote.audio → python_sidecar/venv/
scripts/setup-pyannote.sh --model # Also download diarization model
```

## Architecture

**Build tooling:** electron-vite (Vite-based) with React plugin + Tailwind CSS v4 plugin.

**Three Electron processes:**
- **Main** (`src/main/`) — App lifecycle, window creation, CSP injection, IPC handlers. Security-hardened: navigation blocked, popups denied, sandbox enabled.
- **Preload** (`src/preload/`) — Context bridge exposing APIs to renderer. All IPC channels will use Zod schema validation.
- **Renderer** (`src/renderer/`) — React 19 + Tailwind CSS UI. Path alias: `@renderer` → `src/renderer/src`.

**ML pipeline** (strictly sequential, one model at a time):
1. whisper.cpp subprocess — ASR (Whisper Large V3 Turbo Q5_0, Metal GPU) ✓ implemented
2. Python sidecar — pyannote.audio diarization (speaker-diarization-3.1) + alignment ✓ implemented
3. Python sidecar — flair NER (planned)
4. Swift CLI helper — Apple Vision OCR (planned)

**ML models:** Stored in `~/.therascript/models/<type>/` (e.g. `models/asr/`, `models/diarization/`, `models/ner/`). Directories created at startup by `initDatabase()`.

**Python sidecar:** Uses a venv at `python_sidecar/venv/` (gitignored). One-time setup after fresh clone: `scripts/setup-pyannote.sh --model`. Requires HuggingFace token (`huggingface-cli login`) and accepted terms for `pyannote/speaker-diarization-3.1` + `pyannote/speaker-diarization-community-1`. The venv and models persist across builds — no re-setup needed for `npm run dev/build`.

**Storage:** better-sqlite3 (sessions, blocklist) + electron-store (settings).

**Key constraints:**
- 8 GB minimum RAM budget (~5.2 GB peak during flair NER)
- Production CSP: `connect-src 'none'` (zero network access)
- Context isolation + sandbox always enabled
- All ML models must be swappable (plugin architecture, NFR-9/10)

## Code Conventions

- **Formatting:** Prettier — no semicolons, single quotes, no trailing commas, 100 char line width, 2-space indent
- **Unused vars:** Prefix with `_` (ESLint `@typescript-eslint/no-unused-vars` with `^_` pattern)
- **TypeScript:** Strict mode, separate configs for node (`tsconfig.node.json`) and web (`tsconfig.web.json`)
- **Testing:** Vitest + @testing-library/react + jsdom. Globals enabled (no imports needed for describe/it/expect). Test files: `*.{test,spec}.{ts,tsx}` anywhere in `src/`
- **Window chrome:** macOS `hiddenInset` title bar with custom drag regions (`.titlebar-drag` / `.titlebar-no-drag` CSS classes)

## Domain-Specific Rules

- **Sperrliste (blocklist):** 7 user-visible entity types, bidirectional Umlaut normalization, longest-match-first replacement
- **Placeholder format:** `[PERSON 1]`, `[ORT 1]`, etc. — numeric, type-specific
- **flair ORG entities:** Ignored (institutions only via Sperrliste/manual)
- **Auto-deletion:** Sessions deleted 30 days after creation, silent
- **Auto-stop recording:** 2 hours max
- **Password-protected PDFs:** Not supported
