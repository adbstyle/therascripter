# Development Setup

Complete guide for setting up a local Therascript development environment from a fresh clone.

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| macOS | 26+ (Tahoe) | Apple Silicon (M1-M4) required; the bundled `libggml-metal.0.dylib` (whisper.cpp Metal backend) is linked against the macOS-26 SDK — see Issue #97 |
| Node.js | 18+ | `brew install node` |
| npm | (bundled with Node.js) | |
| Python | 3.10+ (3.12 recommended) | `brew install python@3.12` |
| Homebrew | latest | [brew.sh](https://brew.sh) |
| Xcode CLI Tools | latest | `xcode-select --install` |
| Swift | (bundled with Xcode CLI Tools) | Required for Vision OCR build |

Xcode Command Line Tools provide both the macOS SDK (needed for native module compilation) and the Swift toolchain (needed for the Vision OCR CLI helper).

## Fresh Clone Setup

Order matters. The Python venv must exist before NER setup, and all ML models should be downloaded for a fully functional dev environment.

### 1. Install Node.js dependencies

```bash
npm install
```

This triggers `postinstall` automatically, which runs `electron-rebuild` for better-sqlite3 against the Electron ABI.

### 2. Verify native module rebuild

If `postinstall` did not run or you see ABI mismatch errors later, rebuild manually:

```bash
npm run postinstall
```

This runs `SDKROOT=$(xcrun --show-sdk-path) electron-rebuild -f -w better-sqlite3`.

### 3. Install whisper.cpp and download the ASR model

```bash
scripts/setup-whisper.sh --model
```

What this does:
- Installs `whisper-cpp` via Homebrew (if not already installed)
- Copies `whisper-cli` binary to `resources/bin/`
- Copies required `.dylib` files to `resources/lib/`
- Downloads the Whisper Large V3 Turbo Q5_0 model (~547 MB) to `~/.therascript/models/asr/`

Without `--model`, only the binary and libraries are set up.

### 4. Set up HuggingFace authentication

The pyannote diarization model requires a HuggingFace token and accepted model terms **before** downloading.

1. Create an account at [huggingface.co](https://huggingface.co)
2. Accept the terms for both models:
   - [pyannote/speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)
   - [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)
3. Log in via the CLI (token is stored in `~/.cache/huggingface/`):

```bash
pip install huggingface-cli   # if not already available
huggingface-cli login
```

### 5. Create Python venv and download diarization model

```bash
scripts/setup-pyannote.sh --model
```

What this does:
- Creates a Python virtual environment at `python_sidecar/venv/`
- Installs pyannote.audio, PyTorch, and dependencies from `python_sidecar/requirements.txt`
- Downloads the pyannote speaker-diarization-3.1 model (~1.5 GB with torch deps) to `~/.therascript/models/diarization/`

The script searches for Python in this order: `python3.12`, `python3.11`, `python3.10`, `python3`.

### 6. Install flair NER and download the NER model

```bash
scripts/setup-ner.sh --model
```

What this does:
- Installs flair and NER dependencies from `python_sidecar/requirements-ner.txt` into the **existing** venv (created by step 5)
- Downloads `flair/ner-german-large` (~2.2 GB) to `~/.therascript/models/ner/`

This step **requires** the venv from step 5 to already exist.

### 7. Build the Swift Vision OCR CLI

```bash
scripts/setup-vision-ocr.sh
```

Compiles the Swift Vision OCR helper (arm64 release build) and places it at `resources/bin/vision-ocr`. Used for OCR on scanned PDF pages.

### 8. Start the dev server

```bash
npm run dev
```

This launches Electron with Vite HMR. The `predev` script automatically runs `electron-rebuild` for better-sqlite3 before starting.

Note: The `dev` script uses `env -u ELECTRON_RUN_AS_NODE` to unset that environment variable, which is necessary because Electron Fuses disable RunAsNode. Without this workaround, `electron-vite dev` fails.

## Total model download sizes

| Model | Size | Location |
|---|---|---|
| Whisper Large V3 Turbo Q5_0 | ~547 MB | `~/.therascript/models/asr/` |
| pyannote diarization | ~1.5 GB | `~/.therascript/models/diarization/` |
| flair NER German Large | ~2.2 GB | `~/.therascript/models/ner/` |
| **Total** | **~4.1 GB** | |

Models are stored in `~/.therascript/models/` and persist across app builds and updates.

## Python Sidecar Modes

Therascript uses a Python sidecar process for diarization (pyannote.audio) and NER (flair). There are two modes:

### Dev mode (venv)

- Location: `python_sidecar/venv/`
- Created by `scripts/setup-pyannote.sh`, extended by `scripts/setup-ner.sh`
- Used when running `npm run dev`
- One-time setup; persists across builds

### Production mode (standalone)

- Location: `python_sidecar/standalone/`
- Built via `npm run sidecar:build` (uses `uv` with python-build-standalone, ~1 GB)
- Fully relocatable Python distribution with all dependencies baked in
- Includes `torchcodec_shim.py` loaded via `sitecustomize.py` (provides soundfile-based fallback for torchcodec)
- All `.dylib`/`.so` files are ad-hoc codesigned during build
- If the standalone sidecar fails, try `scripts/build-sidecar.sh --clean` for a fresh build

## What Persists Across Builds

These directories survive `npm run build`, `npm run package`, and git operations (they are gitignored):

- `python_sidecar/venv/` -- Python virtual environment with all dependencies
- `~/.therascript/models/` -- All downloaded ML models (ASR, diarization, NER)
- `resources/bin/` and `resources/lib/` -- whisper-cli binary and dylibs, Vision OCR binary

No re-setup is needed after pulling new code unless dependencies change.

## Useful Dev Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Electron app with Vite HMR |
| `npm run test` | Run all tests (vitest, single run) |
| `npm run test:watch` | Run tests in watch mode |
| `vitest run src/path/to/file.test.ts` | Run a single test file |
| `npm run lint` | ESLint with cache |
| `npm run format` | Prettier formatting |
| `npm run typecheck` | TypeScript check (both node + web configs) |
| `npm run build` | TypeCheck + electron-vite build |
| `npm run package` | electron-rebuild + build + electron-builder (macOS DMG, arm64) |

## Common Errors

### better-sqlite3 ABI mismatch

**Symptom:** Errors about `NODE_MODULE_VERSION` mismatch or "was compiled against a different Node.js version".

**Cause:** better-sqlite3 was compiled for the system Node.js ABI but Electron expects its own ABI (or vice versa).

**Fix:**

```bash
npm run postinstall
```

This runs `electron-rebuild -f -w better-sqlite3` with the correct `SDKROOT`. For tests (which run under system Node.js, not Electron), the `pretest` script automatically runs `npm rebuild better-sqlite3`.

### ELECTRON_RUN_AS_NODE error

**Symptom:** `electron-vite dev` fails to start.

**Cause:** Electron Fuses disable `RunAsNode`, but `electron-vite` needs it internally.

**Fix:** This is already handled by the `dev` script (`env -u ELECTRON_RUN_AS_NODE electron-vite dev`). If you run `electron-vite dev` directly, prefix with `env -u ELECTRON_RUN_AS_NODE`.

### HuggingFace authentication failure

**Symptom:** `setup-pyannote.sh --model` fails with an authentication error.

**Fix:**
1. Ensure you have a HuggingFace account and token: `huggingface-cli login`
2. Accept terms for both `pyannote/speaker-diarization-3.1` and `pyannote/speaker-diarization-community-1` on the HuggingFace website
3. Re-run the setup script

### Swift build failure for Vision OCR

**Symptom:** `setup-vision-ocr.sh` fails with "Swift is not installed".

**Fix:** Install Xcode Command Line Tools: `xcode-select --install`
