# Standalone Python Sidecar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace PyInstaller-based Python sidecar with a relocatable standalone Python environment built via uv, eliminating recurring dependency hell.

**Architecture:** Ship a complete Python 3.12 (from python-build-standalone via uv) with all pip-installed dependencies as `extraResources` in the Electron app. The existing `diarize.py` and `ner_service.py` scripts run unchanged — only the binary invocation path changes from a PyInstaller-frozen executable to `standalone/bin/python3 script.py`.

**Tech Stack:** uv (Python manager), python-build-standalone (relocatable CPython), codesign (macOS ad-hoc signing)

**Design doc:** `docs/plans/2026-02-27-standalone-python-sidecar-design.md`

---

### Task 1: Create torchcodec shim file

Rename the PyInstaller runtime hook to a standalone shim module. The content is identical — only the docstring and filename change.

**Files:**
- Create: `python_sidecar/torchcodec_shim.py`

**Step 1: Create the shim file**

Copy `python_sidecar/runtime_hook_no_torchcodec.py` to `python_sidecar/torchcodec_shim.py` with an updated docstring:

```python
"""
torchcodec shim: Provide soundfile-based fallback for torchcodec.

pyannote.audio 4.0.4+ requires torchcodec for audio I/O (AudioDecoder, AudioSamples,
AudioStreamMetadata). torchcodec's native .dylib uses importlib.machinery.FileFinder
which doesn't work reliably in relocatable Python environments.

torchaudio 2.10.0 also delegates to torchcodec internally, so it can't be used either.

This module registers fake torchcodec modules that implement the required API surface
using soundfile + torch directly. pyannote's `from torchcodec.decoders import AudioDecoder`
then gets our soundfile-based shim instead of the real torchcodec.

Loaded automatically via sitecustomize.py in the standalone Python environment.
"""
```

The rest of the file (everything from `import sys` onward) is identical to `runtime_hook_no_torchcodec.py`.

**Step 2: Verify the file**

Run: `diff <(tail -n +14 python_sidecar/runtime_hook_no_torchcodec.py) <(tail -n +16 python_sidecar/torchcodec_shim.py)`
Expected: No differences (the code portion is identical)

**Step 3: Commit**

```bash
git add python_sidecar/torchcodec_shim.py
git commit -m "Add torchcodec_shim.py for standalone Python sidecar"
```

---

### Task 2: Write the new build script

Replace `scripts/build-sidecar.sh` with a uv-based build that creates a relocatable Python environment.

**Files:**
- Modify: `scripts/build-sidecar.sh` (complete rewrite)

**Step 1: Write the new build script**

```bash
#!/usr/bin/env bash
# Build relocatable Python sidecar via uv.
#
# Produces: python_sidecar/standalone/ (complete Python 3.12 + all ML deps)
#
# Prerequisites:
#   - uv installed (brew install uv)
#   - macOS ARM64 (Apple Silicon)
#
# Usage:
#   scripts/build-sidecar.sh          # full build
#   scripts/build-sidecar.sh --clean  # remove existing standalone dir first
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_ROOT/python_sidecar"
STANDALONE_DIR="$SIDECAR_DIR/standalone"
PYTHON_VERSION="3.12"

# --- Parse args ---
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# --- Check prerequisites ---
if ! command -v uv &>/dev/null; then
  echo "Error: uv is required. Install via: brew install uv"
  exit 1
fi

echo "Using uv $(uv --version)"

# --- Clean if requested ---
if [ "$CLEAN" = true ] && [ -d "$STANDALONE_DIR" ]; then
  echo "=== Cleaning previous standalone build ==="
  rm -rf "$STANDALONE_DIR"
fi

# --- 1. Install standalone Python ---
echo ""
echo "=== Step 1/5: Installing standalone Python $PYTHON_VERSION ==="

uv python install "cpython-${PYTHON_VERSION}" \
  --install-dir "$STANDALONE_DIR" \
  --reinstall

# Find the actual Python binary (uv creates a versioned subdirectory)
PYTHON_BIN=$(find "$STANDALONE_DIR" -name "python3" -path "*/bin/python3" -type f | head -1)
if [ -z "$PYTHON_BIN" ]; then
  # Try symlink
  PYTHON_BIN=$(find "$STANDALONE_DIR" -name "python3" -path "*/bin/python3" | head -1)
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "Error: Python binary not found in $STANDALONE_DIR"
  echo "Contents:"
  find "$STANDALONE_DIR" -maxdepth 3 -type f -name "python*" 2>/dev/null
  exit 1
fi

PYTHON_DIR="$(dirname "$(dirname "$PYTHON_BIN")")"
echo "Python installed at: $PYTHON_BIN"
"$PYTHON_BIN" --version

# --- 2. Install ML dependencies ---
echo ""
echo "=== Step 2/5: Installing ML dependencies ==="

uv pip install \
  --python "$PYTHON_BIN" \
  -r "$SIDECAR_DIR/requirements.txt" \
  -r "$SIDECAR_DIR/requirements-ner.txt"

echo "Dependencies installed."

# --- 3. Install torchcodec shim via sitecustomize ---
echo ""
echo "=== Step 3/5: Installing torchcodec shim ==="

# Find site-packages directory
SITE_PACKAGES=$("$PYTHON_BIN" -c "import site; print(site.getsitepackages()[0])")
echo "site-packages: $SITE_PACKAGES"

# Write sitecustomize.py that loads the torchcodec shim
cat > "$SITE_PACKAGES/sitecustomize.py" << 'SITECUSTOMIZE_EOF'
"""Auto-load torchcodec shim before any app code.

This file is auto-generated by scripts/build-sidecar.sh.
It loads torchcodec_shim.py which provides a soundfile-based fallback
for torchcodec (required by pyannote.audio 4.0.4+).
"""
import importlib.util
import os
import sys

# torchcodec_shim.py lives next to diarize.py and ner_service.py
# In production: <resources>/ml_sidecar/torchcodec_shim.py
# The script's directory is passed via the working directory or PYTHONPATH
# We search relative to __file__ (site-packages) and common locations
_candidates = [
    # Relative to standalone Python (production layout: ml_sidecar/standalone/...)
    os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'torchcodec_shim.py')),
    # Relative to standalone Python (alternative depth)
    os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'torchcodec_shim.py')),
    # Current working directory
    os.path.join(os.getcwd(), 'torchcodec_shim.py'),
]

for _shim_path in _candidates:
    if os.path.isfile(_shim_path):
        _spec = importlib.util.spec_from_file_location('torchcodec_shim', _shim_path)
        _mod = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        break
SITECUSTOMIZE_EOF

echo "sitecustomize.py installed."

# --- 4. Ad-hoc codesign all native binaries ---
echo ""
echo "=== Step 4/5: Code-signing native binaries ==="

SIGN_COUNT=0
while IFS= read -r -d '' dylib; do
  codesign --sign - --force --no-strict "$dylib" 2>/dev/null && SIGN_COUNT=$((SIGN_COUNT + 1)) || true
done < <(find "$PYTHON_DIR" \( -name '*.dylib' -o -name '*.so' \) -print0)

# Also sign the Python binary itself
codesign --sign - --force --no-strict "$PYTHON_BIN" 2>/dev/null || true
SIGN_COUNT=$((SIGN_COUNT + 1))

echo "Signed $SIGN_COUNT native binaries."

# --- 5. Verify ---
echo ""
echo "=== Step 5/5: Verifying build ==="

# Test that Python can import the key packages
"$PYTHON_BIN" -c "
import torch
print(f'  torch {torch.__version__} (MPS: {torch.backends.mps.is_available()})')
"

"$PYTHON_BIN" -c "
import pyannote.audio
print(f'  pyannote.audio {pyannote.audio.__version__}')
"

"$PYTHON_BIN" -c "
import flair
print(f'  flair {flair.__version__}')
"

# Test that diarize.py and ner_service.py can at least parse args
"$PYTHON_BIN" "$SIDECAR_DIR/diarize.py" --help > /dev/null 2>&1 && echo "  diarize.py: OK" || echo "  diarize.py: FAILED"
"$PYTHON_BIN" "$SIDECAR_DIR/ner_service.py" --help > /dev/null 2>&1 && echo "  ner_service.py: OK" || echo "  ner_service.py: FAILED"

# Report sizes
echo ""
echo "=== Build erfolgreich ==="
echo ""
echo "Python: $PYTHON_BIN"
echo ""
echo "Size breakdown:"
du -sh "$PYTHON_DIR/"
echo ""
echo "Standalone total:"
du -sh "$STANDALONE_DIR/"
```

**Step 2: Make executable**

Run: `chmod +x scripts/build-sidecar.sh`

**Step 3: Run the build script to verify it works**

Run: `scripts/build-sidecar.sh --clean`
Expected: Script completes with "Build erfolgreich", torch/pyannote/flair imports succeed, diarize.py and ner_service.py report "OK".

This step will take several minutes (downloading Python + installing ~1 GB of ML packages).

**Step 4: Check the output structure**

Run: `find python_sidecar/standalone -maxdepth 4 -type d | head -20`
Expected: Directory tree with `bin/`, `lib/python3.12/`, `lib/python3.12/site-packages/`

Run: `du -sh python_sidecar/standalone/`
Expected: ~1.2-1.5 GB

**Step 5: Commit**

```bash
git add scripts/build-sidecar.sh
git commit -m "Rewrite build-sidecar.sh: replace PyInstaller with standalone Python via uv"
```

---

### Task 3: Update .gitignore

Add the standalone directory to .gitignore (it's a build artifact, ~1.2 GB).

**Files:**
- Modify: `.gitignore`

**Step 1: Add standalone to .gitignore**

Add after the existing `python_sidecar/venv/` line:

```
python_sidecar/standalone/
```

**Step 2: Verify**

Run: `git status python_sidecar/standalone/`
Expected: Directory should not appear in untracked files

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "Add python_sidecar/standalone/ to .gitignore"
```

---

### Task 4: Update PyannoteSidecar.ts production path

Change the production `getCommand()` to use standalone Python + script instead of PyInstaller binary.

**Files:**
- Modify: `src/main/ml/PyannoteSidecar.ts:20-31`

**Step 1: Update getCommand()**

Replace the existing `getCommand()` method:

```typescript
private getCommand(): { bin: string; args: string[] } {
  if (app.isPackaged) {
    // Production: standalone Python + diarize.py script in extraResources
    const python = join(process.resourcesPath, 'ml_sidecar', 'standalone', 'bin', 'python3')
    const script = join(process.resourcesPath, 'ml_sidecar', 'diarize.py')
    return { bin: python, args: [script] }
  }
  // Dev: use venv Python + script
  const venvPython = join(app.getAppPath(), 'python_sidecar', 'venv', 'bin', 'python3')
  const pythonPath = existsSync(venvPython) ? venvPython : 'python3'
  const scriptPath = join(app.getAppPath(), 'python_sidecar', 'diarize.py')
  return { bin: pythonPath, args: [scriptPath] }
}
```

Also update the JSDoc comment above it:

```typescript
/**
 * Resolve the diarize script path.
 * Production: standalone Python + diarize.py bundled in extraResources.
 * Dev: venv Python + diarize.py script.
 */
```

**Step 2: Verify existing tests still pass**

Run: `vitest run src/main/ml/__tests__/PyannoteSidecar.test.ts`
Expected: All tests pass (tests only cover `parseRTTM` and `buildDiarizationData`, not `getCommand`)

**Step 3: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add src/main/ml/PyannoteSidecar.ts
git commit -m "Update PyannoteSidecar to use standalone Python instead of PyInstaller binary"
```

---

### Task 5: Update AnonymizationService.ts production path

Same change as Task 4, but for the NER service.

**Files:**
- Modify: `src/main/ml/AnonymizationService.ts:26-35`

**Step 1: Update getCommand()**

Replace the existing `getCommand()` method:

```typescript
private getCommand(): { bin: string; args: string[] } {
  if (app.isPackaged) {
    // Production: standalone Python + ner_service.py script in extraResources
    const python = join(process.resourcesPath, 'ml_sidecar', 'standalone', 'bin', 'python3')
    const script = join(process.resourcesPath, 'ml_sidecar', 'ner_service.py')
    return { bin: python, args: [script] }
  }
  const venvPython = join(app.getAppPath(), 'python_sidecar', 'venv', 'bin', 'python3')
  const pythonPath = existsSync(venvPython) ? venvPython : 'python3'
  const scriptPath = join(app.getAppPath(), 'python_sidecar', 'ner_service.py')
  return { bin: pythonPath, args: [scriptPath] }
}
```

Also update the JSDoc comment:

```typescript
/**
 * Resolve the ner_service script path.
 * Production: standalone Python + ner_service.py bundled in extraResources.
 * Dev: venv Python + ner_service.py script.
 */
```

**Step 2: Verify TypeScript compiles**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/main/ml/AnonymizationService.ts
git commit -m "Update AnonymizationService to use standalone Python instead of PyInstaller binary"
```

---

### Task 6: Update electron-builder.yml

Change `extraResources` to package the standalone Python + scripts instead of the PyInstaller dist.

**Files:**
- Modify: `electron-builder.yml:31-34`

**Step 1: Replace the ml_sidecar extraResources entry**

Replace lines 31-34:

```yaml
  - from: python_sidecar/dist/ml_sidecar
    to: ml_sidecar
    filter:
      - '**/*'
```

With:

```yaml
  - from: python_sidecar/standalone
    to: ml_sidecar/standalone
    filter:
      - '**/*'
  - from: python_sidecar/diarize.py
    to: ml_sidecar/diarize.py
  - from: python_sidecar/ner_service.py
    to: ml_sidecar/ner_service.py
  - from: python_sidecar/torchcodec_shim.py
    to: ml_sidecar/torchcodec_shim.py
```

**Step 2: Verify the YAML is valid**

Run: `node -e "const yml = require('js-yaml'); const fs = require('fs'); yml.load(fs.readFileSync('electron-builder.yml', 'utf8')); console.log('YAML valid')"`
Expected: "YAML valid"

**Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "Update electron-builder to package standalone Python instead of PyInstaller dist"
```

---

### Task 7: Remove PyInstaller artifacts

Clean up all PyInstaller-specific files that are no longer needed.

**Files:**
- Delete: `python_sidecar/ml_sidecar.spec`
- Delete: `python_sidecar/runtime_hook_no_torchcodec.py`
- Delete: `python_sidecar/dist/` (if exists, should be gitignored already)
- Delete: `python_sidecar/build/` (if exists, should be gitignored already)

**Step 1: Remove PyInstaller spec and runtime hook**

```bash
rm python_sidecar/ml_sidecar.spec
rm python_sidecar/runtime_hook_no_torchcodec.py
```

**Step 2: Remove PyInstaller build artifacts (if present)**

```bash
rm -rf python_sidecar/dist/
rm -rf python_sidecar/build/
```

**Step 3: Verify no PyInstaller references remain in tracked files**

Run: `grep -r "pyinstaller\|PyInstaller\|ml_sidecar\.spec\|runtime_hook_no_torchcodec" --include='*.ts' --include='*.sh' --include='*.yml' --include='*.json' --include='*.md' .`
Expected: Only matches in design docs, CLAUDE.md, and git history — no active code references.

**Step 4: Commit**

```bash
git add -u python_sidecar/ml_sidecar.spec python_sidecar/runtime_hook_no_torchcodec.py
git commit -m "Remove PyInstaller spec, runtime hook, and build artifacts"
```

---

### Task 8: Update CLAUDE.md

Update the project documentation to reflect the new sidecar build approach.

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the Commands section**

Replace the `npm run sidecar:build` description:

```
npm run sidecar:build              # Build standalone Python sidecar via uv → python_sidecar/standalone/
```

**Step 2: Update the Architecture section**

In the "Python sidecar" paragraph, replace the content about PyInstaller with:

```
**Python sidecar:** Two modes: (1) **Dev**: Python venv at `python_sidecar/venv/` — one-time setup after fresh clone: `scripts/setup-pyannote.sh --model` then `scripts/setup-ner.sh --model`. (2) **Production**: Standalone relocatable Python at `python_sidecar/standalone/` built via `uv` (no PyInstaller, no venv needed). Build with `npm run sidecar:build`. The torchcodec shim (`torchcodec_shim.py`) is loaded via `sitecustomize.py` in the standalone environment. Pyannote requires HuggingFace token (`huggingface-cli login`) and accepted terms for `pyannote/speaker-diarization-3.1` + `pyannote/speaker-diarization-community-1`. The venv and models persist across builds — no re-setup needed for `npm run dev/build`.
```

**Step 3: Update the Gotchas section**

Remove or update any PyInstaller-specific gotchas. Add:

```
- **Standalone Python sidecar:** Built via `uv` with python-build-standalone. All `.dylib`/`.so` files are ad-hoc codesigned during build. If the sidecar fails to run, try `scripts/build-sidecar.sh --clean` for a fresh build. The `torchcodec_shim.py` provides a soundfile-based fallback for torchcodec (required by pyannote.audio 4.0.4+).
```

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md: document standalone Python sidecar (replaces PyInstaller)"
```

---

### Task 9: End-to-end verification

Verify the complete pipeline works: build sidecar, build app, run ML pipeline.

**Step 1: Build the standalone sidecar (if not already done in Task 2)**

Run: `npm run sidecar:build`
Expected: Completes successfully

**Step 2: Run the dev app and verify ML pipeline**

Run: `npm run dev`

Test manually:
1. Start a recording (or use an existing session)
2. Verify diarization completes (check progress in UI)
3. Verify NER/anonymization completes (check progress in UI)
4. Verify review editor shows anonymized content

**Step 3: Build the production package**

Run: `npm run sidecar:build && npm run package`
Expected: DMG is created in `dist/`

**Step 4: Verify production app**

1. Mount the DMG
2. Right-click → Open the app
3. Run a session through the full pipeline
4. Verify diarization and anonymization work correctly

**Step 5: Report final bundle sizes**

Run:
```bash
echo "Standalone sidecar:"
du -sh python_sidecar/standalone/
echo ""
echo "DMG:"
ls -lh dist/*.dmg
```

---

## Summary of Changes

| File | Action | Description |
|------|--------|-------------|
| `python_sidecar/torchcodec_shim.py` | Create | Renamed shim (from runtime hook) |
| `scripts/build-sidecar.sh` | Rewrite | uv-based build replacing PyInstaller |
| `.gitignore` | Modify | Add `python_sidecar/standalone/` |
| `src/main/ml/PyannoteSidecar.ts` | Modify | Production path: standalone Python + script |
| `src/main/ml/AnonymizationService.ts` | Modify | Production path: standalone Python + script |
| `electron-builder.yml` | Modify | Package standalone dir + scripts |
| `python_sidecar/ml_sidecar.spec` | Delete | PyInstaller config removed |
| `python_sidecar/runtime_hook_no_torchcodec.py` | Delete | Replaced by `torchcodec_shim.py` |
| `CLAUDE.md` | Modify | Update documentation |

## Rollback Plan

If the standalone approach fails:
1. `git revert` all commits on this branch
2. The PyInstaller-based build will still work as before
3. `python_sidecar/venv/` and dev workflow are never touched
