# Design: PyInstaller → Standalone Python via uv

**Date:** 2026-02-27
**Status:** Approved
**Author:** Adrian Bader + Claude

## Problem

The PyInstaller-based Python sidecar (`ml_sidecar.spec`, 236 lines) is a recurring source of debugging effort. PyInstaller statically analyzes imports but PyTorch, pyannote.audio, and flair have deeply interconnected dynamic/lazy imports that static analysis cannot reliably trace.

Recent commit history demonstrates the pattern:
- `0f7a302` Fix PyInstaller excludes: stop excluding modules needed at runtime
- `7d01591` Narrow torch.testing exclusion to _internal only in PyInstaller spec
- `98f0a5a` Fix diarization crash: stop excluding torch.utils.data.datapipes
- `0864cf9` Fix diarization crash: stop excluding torch.distributed

Each fix involves discovering that a PyInstaller exclude broke a lazy import. This is inherently fragile and will recur with every dependency update.

## Solution

Replace PyInstaller with a **relocatable standalone Python** built via [uv](https://github.com/astral-sh/uv) (from astral-sh, same team as python-build-standalone). Ship the complete Python environment with all dependencies as `extraResources` in the Electron app.

**Principle:** If it works in the venv, it works in the bundle. No import analysis, no excludes, no runtime hooks.

## Directory Structure (After)

```
python_sidecar/
  standalone/                  # NEW: relocatable Python (build artifact, gitignored)
    bin/
      python3                  # standalone Python binary
    lib/
      python3.12/
        site-packages/
          torch/, pyannote/, flair/, soundfile/, ...
          sitecustomize.py     # auto-loads torchcodec shim
  diarize.py                   # unchanged
  ner_service.py               # unchanged
  torchcodec_shim.py           # renamed from runtime_hook_no_torchcodec.py
  requirements.txt             # unchanged
  requirements-ner.txt         # unchanged
  venv/                        # kept for dev (npm run dev)
```

**Removed:**
- `ml_sidecar.spec` (236 lines of PyInstaller config)
- `runtime_hook_no_torchcodec.py` (becomes `torchcodec_shim.py`)
- `dist/ml_sidecar/` (PyInstaller output)
- `build/` directory (PyInstaller build artifacts)

## Build Script (`scripts/build-sidecar.sh`)

New implementation using uv:

1. **Install standalone Python:** `uv python install cpython-3.12-macos-aarch64` into `python_sidecar/standalone/`
2. **Install dependencies:** `uv pip install --python standalone/bin/python3 -r requirements.txt -r requirements-ner.txt`
3. **Install torchcodec shim:** Copy `sitecustomize.py` into `standalone/lib/python3.12/site-packages/` that pre-loads the torchcodec shim before any app code
4. **Ad-hoc codesign:** `find standalone/ \( -name '*.dylib' -o -name '*.so' \) -exec codesign --sign - --force {} \;`
5. **Verify:** Run `standalone/bin/python3 diarize.py --help` and `ner_service.py --help` to confirm everything works

## torchcodec Shim

The existing `runtime_hook_no_torchcodec.py` shimming approach is preserved (soundfile-based fallback for torchcodec's AudioDecoder). Instead of being a PyInstaller runtime hook, it becomes:

1. `python_sidecar/torchcodec_shim.py` — the shim code (renamed, content unchanged)
2. `sitecustomize.py` — installed into `standalone/lib/python3.12/site-packages/` during build:
   ```python
   """Auto-load torchcodec shim before any app code."""
   import importlib.util
   import os
   shim = os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'torchcodec_shim.py')
   if os.path.exists(shim):
       spec = importlib.util.spec_from_file_location('torchcodec_shim', shim)
       mod = importlib.util.module_from_spec(spec)
       spec.loader.exec_module(mod)
   ```

This ensures the shim runs before `import pyannote.audio` regardless of how Python is invoked.

## Electron Integration (TypeScript Changes)

### PyannoteSidecar.ts — `getCommand()` production path

```typescript
// Before (PyInstaller binary):
const binary = join(process.resourcesPath, 'ml_sidecar', 'diarize')
return { bin: binary, args: [] }

// After (standalone Python + script):
const python = join(process.resourcesPath, 'ml_sidecar', 'standalone', 'bin', 'python3')
const script = join(process.resourcesPath, 'ml_sidecar', 'diarize.py')
return { bin: python, args: [script] }
```

### AnonymizationService.ts — identical change

```typescript
// Before:
const binary = join(process.resourcesPath, 'ml_sidecar', 'ner_service')
return { bin: binary, args: [] }

// After:
const python = join(process.resourcesPath, 'ml_sidecar', 'standalone', 'bin', 'python3')
const script = join(process.resourcesPath, 'ml_sidecar', 'ner_service.py')
return { bin: python, args: [script] }
```

The `spawn()` calls, progress parsing, timeouts, and error handling remain completely unchanged. Only the binary path changes.

## electron-builder.yml

```yaml
# Before:
extraResources:
  - from: python_sidecar/dist/ml_sidecar
    to: ml_sidecar
    filter:
      - '**/*'

# After:
extraResources:
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

## Bundle Size

| Component | PyInstaller (current) | Standalone (new) |
|---|---|---|
| Python + torch + pyannote + flair | 675 MB | ~1.2-1.5 GB |
| **Delta** | | **+500-800 MB** |

The standalone Python is larger because PyInstaller does tree-shaking (only bundles used modules). We ship the complete site-packages. Trade-off: larger bundle, zero debugging effort.

## npm Scripts

```json
"sidecar:build": "scripts/build-sidecar.sh"  // same name, new implementation
// sidecar:deploy pipeline unchanged
```

## .gitignore Addition

```
python_sidecar/standalone/
```

## What Does NOT Change

- `diarize.py` and `ner_service.py` — zero changes
- Dev workflow (`npm run dev`) — still uses `python_sidecar/venv/`
- Setup scripts (`setup-pyannote.sh`, `setup-ner.sh`) — unchanged, still used for dev
- ML models in `~/.therascript/models/` — untouched
- Progress parsing, timeouts, error handling in TypeScript — untouched
- `afterPack.js` (Electron Fuses) — untouched
- Model download pipeline — untouched

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Standalone Python dylibs have hardcoded paths | uv/python-build-standalone handles relocatability; verify with `otool -L` |
| Ad-hoc codesigning fails for some binaries | Build script verifies each signature; fallback to manual `codesign` |
| Bundle size exceeds 1.5 GB | Acceptable per user decision; can optimize later by removing `__pycache__`, test dirs, docs |
| torchcodec shim doesn't load via sitecustomize | Fallback: set `PYTHONPATH` env var in spawn() to prepend shim directory |
| uv changes python-build-standalone format | Pin uv version in build script |
