#!/usr/bin/env bash
#
# Pre-Release-Verifikation über alle Bundle-Bausteine:
#   1. whisper/llama-Bundles self-contained (keine /opt/homebrew-Refs,
#      keine Dylib-Duplikate, alle @rpath-Refs auflösbar)
#   2. Python-Sidecar geprunt (kein __pycache__/torch-include/pip)
#   3. app.asar (falls gepackt): keine Secret-/Ballast-Leaks, Runtime-Deps
#      vorhanden, Resolve-Gate via verify-asar-resolves.mjs
#
# Usage: ./scripts/verify-bundles.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FAIL=0

check_no_homebrew_refs() {
  local label="$1"; shift
  local found
  found=$(otool -L "$@" 2>/dev/null | grep -E '^\s+/opt/homebrew' || true)
  if [ -n "$found" ]; then
    echo "FAIL [$label]: absolute /opt/homebrew references in:" >&2
    echo "$found" >&2
    FAIL=1
  else
    echo "ok   [$label]: zero /opt/homebrew references"
  fi
}

check_file_present() {
  local label="$1"; local path="$2"
  if [ ! -f "$path" ]; then
    echo "FAIL [$label]: missing $path" >&2
    FAIL=1
  else
    echo "ok   [$label]: $path"
  fi
}

WHISPER_BIN="$REPO_ROOT/resources/whisper/bin/whisper-cli"
WHISPER_LIB="$REPO_ROOT/resources/whisper/lib"
LLAMA_BIN="$REPO_ROOT/resources/llama/bin/llama-cli"
LLAMA_BIN_DIR="$REPO_ROOT/resources/llama/bin"
LLAMA_LIB="$REPO_ROOT/resources/llama/lib"

echo "=== whisper bundle ==="
check_file_present 'whisper-cli'        "$WHISPER_BIN"
check_file_present 'libwhisper.1.dylib' "$WHISPER_LIB/libwhisper.1.dylib"
check_file_present 'libggml.0.dylib'    "$WHISPER_LIB/libggml.0.dylib"
check_no_homebrew_refs 'whisper bundle' "$WHISPER_BIN" "$WHISPER_LIB/"*.dylib

echo ""
echo "=== llama bundle ==="
check_file_present 'llama-cli'              "$LLAMA_BIN"
check_file_present 'libllama.0.dylib'       "$LLAMA_LIB/libllama.0.dylib"
check_file_present 'libggml.0.dylib'        "$LLAMA_LIB/libggml.0.dylib"
check_file_present 'libssl.3.dylib'         "$LLAMA_LIB/libssl.3.dylib"
check_file_present 'libcrypto.3.dylib'      "$LLAMA_LIB/libcrypto.3.dylib"
check_file_present 'libomp.dylib'           "$LLAMA_LIB/libomp.dylib"
check_file_present 'libggml-metal.so'       "$LLAMA_BIN_DIR/libggml-metal.so"
check_file_present 'libggml-blas.so'        "$LLAMA_BIN_DIR/libggml-blas.so"
# At least one CPU backend variant must be present (apple_m1/m2_m3/m4 cover
# all current Apple Silicon Macs).
# Plugins MÜSSEN neben der Executable liegen (bin/): ggml scannt das
# Executable-Verzeichnis; lib/ wird NICHT gescannt und GGML_BACKEND_PATH ist
# kein Suchverzeichnis. Plugins in lib/ = Summarization auf Endnutzer-Macs tot.
if ! ls "$LLAMA_BIN_DIR/"libggml-cpu-apple_*.so >/dev/null 2>&1; then
  echo "FAIL [llama]: no libggml-cpu-apple_*.so backend plugin in $LLAMA_BIN_DIR/ (neben der Executable!)" >&2
  FAIL=1
else
  echo "ok   [llama]: libggml-cpu-apple_*.so plugin present in bin/ ($(ls "$LLAMA_BIN_DIR/"libggml-cpu-apple_*.so | wc -l | tr -d ' ') variant(s))"
fi
check_no_homebrew_refs 'llama bundle' \
  "$LLAMA_BIN" \
  "$LLAMA_LIB/"*.dylib \
  "$LLAMA_BIN_DIR/"*.so

# Duplicate-variant guard: Homebrew ships each dylib under three names; only
# the single-major install names (lib*.N.dylib) are ever loaded. setup-llama.sh
# prunes the rest — fail if a re-run regressed that (~16 MB dead weight).
dupes=$(ls "$LLAMA_LIB"/lib{llama,llama-common,mtmd,ggml,ggml-base}.dylib \
  "$LLAMA_LIB"/lib*.*.*.*.dylib 2>/dev/null || true)
if [ -n "$dupes" ]; then
  echo "FAIL [llama]: unreferenced dylib name variants present (re-run setup-llama.sh):" >&2
  echo "$dupes" >&2
  FAIL=1
else
  echo "ok   [llama]: no duplicate dylib name variants"
fi

# Every @rpath reference in the llama bundle must resolve to a shipped file.
unresolved="$(
  for macho in "$LLAMA_BIN" "$LLAMA_LIB"/*.dylib "$LLAMA_BIN_DIR"/*.so; do
    otool -L "$macho" 2>/dev/null | awk -v self="$(basename "$macho")" \
      '$1 ~ /^@rpath\// { sub(/^@rpath\//, "", $1); if ($1 != self) print $1 }'
  done | sort -u | while read -r dep; do
    if [ ! -f "$LLAMA_LIB/$dep" ]; then echo "$dep"; fi
  done
)"
if [ -n "$unresolved" ]; then
  echo "FAIL [llama]: @rpath references without a bundled file:" >&2
  echo "$unresolved" >&2
  FAIL=1
else
  echo "ok   [llama]: all @rpath references resolve inside the bundle"
fi

echo ""
echo "=== python sidecar ==="
SIDECAR="$REPO_ROOT/python_sidecar/standalone"
if [ -d "$SIDECAR" ]; then
  SP="$SIDECAR/lib/python3.12/site-packages"
  check_file_present 'torch_shm_manager' "$SP/torch/bin/torch_shm_manager"
  for pruned in "$SP/torch/include" "$SP/pip" "$SP/setuptools"; do
    if [ -d "$pruned" ]; then
      echo "FAIL [sidecar]: build-time-only dir shipped: $pruned (re-run build-sidecar.sh)" >&2
      FAIL=1
    fi
  done
  pyc_dirs=$(find "$SIDECAR" -type d -name '__pycache__' -print -quit)
  if [ -n "$pyc_dirs" ]; then
    echo "FAIL [sidecar]: __pycache__ present (unpruned build): $pyc_dirs" >&2
    FAIL=1
  else
    echo "ok   [sidecar]: pruned (no __pycache__, no torch/include, no pip/setuptools)"
  fi
else
  echo "skip [sidecar]: $SIDECAR not built"
fi

# asar hygiene: only meaningful after `npm run package`. The old blacklist
# leaked swift_cli/.build (271 MB), website/ and the .env (R2 credentials!)
# into the shipped archive — never again.
#
# WICHTIG — Grenze dieses Checks: hier stehen nur SECRET-/BALLAST-Leaks
# (Dinge, die NICHT ins Archiv gehören). Eine Präsenzliste über Top-Level-
# Ordner kann NICHT prüfen, ob jede Runtime-Dependency auflösbar ist — genau
# daran ist der PDF-Import gestorben (fehlendes @napi-rs/canvas ⇒ pdfjs nicht
# importierbar), während dieser Check grün war. Diese Eigenschaft prüft
# `scripts/verify-asar-resolves.mjs` (wird unten aufgerufen). Absichtlich
# NICHT auf der forbidden-Liste: @napi-rs — ob es fehlen DARF, entscheidet
# das Resolve-Gate samt dokumentierter Allowlist, nicht ein Pfad-Verbot hier.
echo ""
echo "=== app.asar (if packaged) ==="
ASAR="$REPO_ROOT/dist/mac-arm64/Therascript.app/Contents/Resources/app.asar"
if [ -f "$ASAR" ]; then
  asar_list="$(npx --yes @electron/asar list "$ASAR" 2>/dev/null)"
  ASAR_FAIL=0
  # Herestrings statt `echo | grep -q`: grep -q beendet beim ersten Match und
  # schickt echo unter pipefail ein SIGPIPE — der Check würde flaky failen.
  for forbidden in '/swift_cli' '/.env' '/website' '/src'; do
    if grep -q "^$forbidden" <<<"$asar_list"; then
      echo "FAIL [asar]: forbidden path in app.asar: $forbidden" >&2
      ASAR_FAIL=1
    fi
  done
  for required in '/out/main/index.js' '/package.json' '/node_modules/better-sqlite3' '/node_modules/pdfjs-dist' '/node_modules/zod'; do
    if ! grep -q "^$required" <<<"$asar_list"; then
      echo "FAIL [asar]: required path missing from app.asar: $required" >&2
      ASAR_FAIL=1
    fi
  done
  if [ $ASAR_FAIL -eq 0 ]; then
    echo "ok   [asar]: no secret/ballast leaks, all top-level runtime deps present"
  else
    FAIL=1
  fi

  # Der eigentliche Beweis: löst jeder Runtime-Specifier im Bundle auf?
  echo ""
  echo "=== asar resolve gate ==="
  if node "$SCRIPT_DIR/verify-asar-resolves.mjs" "$ASAR"; then
    :
  else
    FAIL=1
  fi
else
  echo "skip [asar]: not packaged yet"
fi

echo ""
if [ $FAIL -ne 0 ]; then
  echo "VERIFY FAILED — mindestens ein Bundle-Check rot (Details oben). Das DMG würde auf Endnutzer-Macs fehlerhaft laufen." >&2
  exit 1
fi
echo "VERIFY OK — bundles are self-contained."
