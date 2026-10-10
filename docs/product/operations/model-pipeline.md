# Model Pipeline

This document describes how ML models are built, packaged, and published to Cloudflare R2 for distribution to end users.

## Overview

Therascript ships three required ML models that are downloaded on first launch (~1.7 GB total; source of truth for URLs, sizes and hashes: `src/shared/model-catalog.ts`):

| Model | Archive | Size |
|-------|---------|------|
| Whisper Large V3 Turbo (Q5_0) | `whisper-ggml-large-v3-turbo-q5_0.bin` | ~0.6 GB |
| pyannote suite (3.1 + community-1 + sub-models) | `pyannote-suite.tar.gz` | ~0.06 GB |
| flair/ner-german-large (fp16, Issue #131) | `flair-ner-german-large-v3.tar.gz` | ~1.0 GB |

Older artifacts (`flair-ner-german-large.tar.gz`, `-v2.tar.gz`, `pyannote-models.tar.gz`) stay on R2 because shipped app versions verify first-launch downloads against their built-in hashes.

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

### Full deploy (full republish only)

```bash
npm run sidecar:deploy
```

This runs all three steps sequentially: build, package, upload. **Only for a full republish of every artifact under new file names.** `package-models.sh` re-creates `pyannote-suite.tar.gz` with a new gzip timestamp (new hash) and `upload-r2.sh` without arguments uploads everything in `r2-upload/` — that would overwrite R2 objects whose old hashes are built into shipped app versions. To publish one artifact, see "Publishing a single artifact" below.

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
- **Pyannote**: The four required HF-cache folders from `~/.therascript/models/diarization/` are archived into `pyannote-suite.tar.gz`.
- **flair**: A staging copy of `~/.therascript/models/ner/` (without `*-fast.pt` copies and without the fp32 blob) gets a fp16 checkpoint written by `scripts/convert-ner-fp16.py` at the original blob's place, then is archived into `flair-ner-german-large-v3.tar.gz`. The converter re-loads the result and fails unless all parameters come back as fp32.

The script prints SHA-256 hashes and file sizes for each archive.

**Publishing a single artifact:** `scripts/package-models.sh ner` packages only the NER artifact, `scripts/upload-r2.sh r2-upload/<file>` uploads only that file. A full packaging run re-creates `pyannote-suite.tar.gz` with a new gzip timestamp and therefore a new hash — never upload that over the existing R2 object. Before uploading a NER artifact, verify it end to end:

```bash
mkdir -p /tmp/ner-v3 && tar -xzf r2-upload/flair-ner-german-large-v3.tar.gz -C /tmp/ner-v3
scripts/smoke-packaged.sh --staging --ner-model-dir /tmp/ner-v3
python3 scripts/ner-parity.py ~/.therascript/models/ner /tmp/ner-v3
```

### Step 3: Upload to R2 (`npm run sidecar:upload`)

Runs `scripts/upload-r2.sh`. Without arguments it uploads all files in `r2-upload/` (see the warning above); `scripts/upload-r2.sh <file>...` uploads only those files. It uploads to the `therascript` R2 bucket using the AWS CLI S3 compatibility API. Uses multipart upload, so there is no 300 MB file size limit.

After uploading, the script lists bucket contents for verification.

### Step 4: Publish manifest (`scripts/publish-manifest.sh`)

`release.sh` publishes the manifest automatically at the end of every release with `scripts/publish-manifest.sh --from-catalog`: model entries (URL, sha256, size) come straight from `src/shared/model-catalog.ts`, every artifact is checked against R2 via HEAD (exists, `Content-Length` matches), no local files are needed. Upload a new artifact **before** releasing, otherwise this step aborts. `--from-catalog --dry-run` writes `manifest.json` locally without uploading.

The modes below build the manifest from local files instead:

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

1. Update `url`, `sha256` and `sizeBytes` in `src/shared/model-catalog.ts` for the new artifact and run `npm run typecheck`.
2. Verify the artifact via CDN (size and hash must match the catalog):
   `curl -sI https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/<file> | grep -i content-length` and `curl -s https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/<file> | shasum -a 256`.
3. The manifest goes live with the next `scripts/release.sh` run. Check it afterwards with `curl https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/manifest.json | jq .`. `manifest.json` is gitignored, so there is nothing to commit.

## torchcodec shim

pyannote.audio 4.0.4+ requires `torchcodec` for audio I/O. The real torchcodec relies on native `.dylib` loading via `importlib.machinery.FileFinder`, which does not work reliably in relocatable Python environments. torchaudio 2.10.0 also delegates to torchcodec internally, so it cannot be used as an alternative.

The shim (`python_sidecar/torchcodec_shim.py`) registers fake `torchcodec` and `torchcodec.decoders` modules in `sys.modules` that implement the required API surface using `soundfile` + `torch` directly. It provides:

- `AudioDecoder(path).metadata` -- returns sample rate, channels, duration
- `AudioDecoder(path).get_all_samples()` -- reads full audio via soundfile
- `AudioDecoder(path).get_samples_played_in_range(start, end)` -- reads a time range

The shim is loaded automatically at Python startup via `sitecustomize.py`, which the build script installs into the standalone Python's site-packages directory. This means all Python code that imports `torchcodec` gets the shim transparently.

## Rollback

Every artifact generation has its own file name and stays on R2 (shipped app versions verify against their built-in hashes), so a rollback never needs re-packaging or re-uploading:

1. Point the model's entry in `src/shared/model-catalog.ts` back to the previous artifact (`url`, `sha256`, `sizeBytes` from git history).
2. Release as usual with `scripts/release.sh`. It publishes the manifest from the catalog, and existing installs get the previous artifact offered as a model update.

Never re-package and re-upload under an existing file name: gzip timestamps change the hash and break every app version that has the old hash built in.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `uv` not found | `brew install uv` |
| AWS CLI not found | `brew install awscli` |
| R2 credentials missing | Check `.env` file for all three keys |
| Model file not found during packaging | Verify models exist in `~/.therascript/models/` |
| Sidecar build verification fails | Try `scripts/build-sidecar.sh --clean` for a fresh build |
| SHA-256 mismatch on client | Catalog/manifest hash differs from the R2 object. Compare `curl -s <url> \| shasum -a 256` against `src/shared/model-catalog.ts`; never overwrite the R2 object, publish a new file name instead |
| Codesigning failures during build | Non-critical for most files; only matters if macOS kills the process at runtime |
