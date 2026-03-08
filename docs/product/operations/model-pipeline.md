# Model Pipeline

This document describes how ML models are built, packaged, and published to Cloudflare R2 for distribution to end users.

## Overview

Therascript ships three ML models that are downloaded on first launch (~4.1 GB total):

| Model | Archive | Size |
|-------|---------|------|
| Whisper Large V3 Turbo (Q5_0) | `whisper-ggml-large-v3-turbo-q5_0.bin` | ~1.7 GB |
| pyannote speaker-diarization-3.1 | `pyannote-models.tar.gz` | ~0.2 GB |
| flair/ner-german-large | `flair-ner-german-large.tar.gz` | ~2.2 GB |

Models are hosted on Cloudflare R2 behind a public CDN. A `manifest.json` on R2 describes available model versions (SHA-256 checksums, sizes, download URLs). The app checks this manifest at startup to detect updates.

The Python sidecar (pyannote + flair runtime) is **not** distributed via R2 -- it is bundled directly in the DMG via `extraResources`.

## Prerequisites

- macOS with Apple Silicon (ARM64)
- `uv` installed: `brew install uv`
- AWS CLI installed: `brew install awscli`
- `.env` file in project root (never committed) with R2 credentials
- Python venv set up: `scripts/setup-pyannote.sh --model` + `scripts/setup-ner.sh --model`
- All models downloaded locally in `~/.therascript/models/` (asr, diarization, ner subdirectories)

## .env format

Create a `.env` file in the project root with these keys:

```
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<your-r2-access-key>
R2_SECRET_ACCESS_KEY=<your-r2-secret-key>
```

Generate an R2 API token in the Cloudflare Dashboard under R2 > Manage R2 API Tokens. This file is gitignored and must never be committed.

## Pipeline steps

### Full deploy (recommended)

```bash
npm run sidecar:deploy
```

This runs all three steps sequentially: build, package, upload.

### Step 1: Build the sidecar (`npm run sidecar:build`)

Runs `scripts/build-sidecar.sh`. Produces a relocatable standalone Python environment at `python_sidecar/standalone/`.

What it does:

1. **Installs standalone Python 3.12** via `uv python install` using python-build-standalone (~1 GB). The versioned directory (e.g. `cpython-3.12.12-macos-aarch64-none`) is moved to `python_sidecar/standalone/`.
2. **Removes the EXTERNALLY-MANAGED marker** so pip/uv can install packages into this Python.
3. **Installs ML dependencies** from `python_sidecar/requirements.txt` and `python_sidecar/requirements-ner.txt` via `uv pip install`. This includes torch, pyannote.audio, flair, soundfile, and all transitive dependencies.
4. **Installs the torchcodec shim** by writing a `sitecustomize.py` into the standalone Python's site-packages (see section below).
5. **Ad-hoc codesigns all native binaries** -- finds every `.dylib` and `.so` file in the standalone directory and signs them with `codesign --sign - --force --no-strict`. The Python binary itself is also signed. This is required because macOS on Apple Silicon kills unsigned native code. Failures during signing are non-critical (some files may not need signing).
6. **Verifies the build** by importing torch, pyannote.audio, flair, and soundfile, and running `--help` on `diarize.py` and `ner_service.py`.

Options:
- `scripts/build-sidecar.sh --clean` removes the existing standalone directory before rebuilding.
- If the standalone directory already exists and passes verification, the build is skipped.

### Step 2: Package models (`npm run sidecar:package`)

Runs `scripts/package-models.sh`. Reads models from `~/.therascript/models/` and writes archives to `r2-upload/`.

- **Whisper**: Copied as a flat `.bin` file (no archiving needed).
- **Pyannote**: The contents of `~/.therascript/models/diarization/` are archived into `pyannote-models.tar.gz`.
- **flair**: The contents of `~/.therascript/models/ner/` are archived into `flair-ner-german-large.tar.gz`.

The script prints SHA-256 hashes and file sizes for each archive.

### Step 3: Upload to R2 (`npm run sidecar:upload`)

Runs `scripts/upload-r2.sh`. Uploads all files in `r2-upload/` to the `therascript` R2 bucket using the AWS CLI S3 compatibility API. Uses multipart upload, so there is no 300 MB file size limit.

After uploading, the script lists bucket contents for verification.

### Step 4: Publish manifest (`scripts/publish-manifest.sh`)

Generates `manifest.json` from the files in `r2-upload/` and uploads it to R2. For each model the manifest records:

- `id` -- model identifier (e.g. `whisper-large-v3-turbo`)
- `version` -- date string (YYYY-MM-DD)
- `label` -- human-readable label in German
- `url` -- CDN download URL
- `sha256` -- SHA-256 checksum
- `sizeBytes` -- file size in bytes

The manifest also includes `latestAppVersion` (read from `package.json`) and `generatedAt` (UTC timestamp).

Options:
- `scripts/publish-manifest.sh --dry-run` generates the manifest locally without uploading.
- `scripts/publish-manifest.sh --app-version-only` downloads the existing manifest from R2, patches only the `latestAppVersion` field, and re-uploads. This does not require model files in `r2-upload/`.

### After upload

1. Run `npm run typecheck` to verify nothing is broken.
2. Commit the manifest: `git add manifest.json && git commit -m "chore: update model manifest"`.
3. Verify via CDN: `curl https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json | jq .`.

## torchcodec shim

pyannote.audio 4.0.4+ requires `torchcodec` for audio I/O. The real torchcodec relies on native `.dylib` loading via `importlib.machinery.FileFinder`, which does not work reliably in relocatable Python environments. torchaudio 2.10.0 also delegates to torchcodec internally, so it cannot be used as an alternative.

The shim (`python_sidecar/torchcodec_shim.py`) registers fake `torchcodec` and `torchcodec.decoders` modules in `sys.modules` that implement the required API surface using `soundfile` + `torch` directly. It provides:

- `AudioDecoder(path).metadata` -- returns sample rate, channels, duration
- `AudioDecoder(path).get_all_samples()` -- reads full audio via soundfile
- `AudioDecoder(path).get_samples_played_in_range(start, end)` -- reads a time range

The shim is loaded automatically at Python startup via `sitecustomize.py`, which the build script installs into the standalone Python's site-packages directory. This means all Python code that imports `torchcodec` gets the shim transparently.

## Rollback

R2 does not version files automatically. To roll back a model:

1. Restore the old model locally (e.g. from Time Machine).
2. Run `npm run sidecar:package` with the old model files.
3. Run `npm run sidecar:upload`.
4. Run `scripts/publish-manifest.sh` to regenerate and upload the manifest.
5. Commit: `git add manifest.json && git commit -m "chore: rollback model manifest"`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `uv` not found | `brew install uv` |
| AWS CLI not found | `brew install awscli` |
| R2 credentials missing | Check `.env` file for all three keys |
| Model file not found during packaging | Verify models exist in `~/.therascript/models/` |
| Sidecar build verification fails | Try `scripts/build-sidecar.sh --clean` for a fresh build |
| SHA-256 mismatch on client | Re-run package + upload + publish-manifest |
| Codesigning failures during build | Non-critical for most files; only matters if macOS kills the process at runtime |
