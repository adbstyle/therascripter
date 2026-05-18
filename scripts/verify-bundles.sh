#!/usr/bin/env bash
#
# Verify that the whisper and llama bundles under resources/<tool>/ are fully
# self-contained: no absolute /opt/homebrew references in any Mach-O, all
# required runtime dependencies present. Intended as a pre-package smoke
# check; fails fast if the DMG would crash on Macs without Homebrew.
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
check_file_present 'libggml-metal.so'       "$LLAMA_LIB/libggml-metal.so"
check_file_present 'libggml-blas.so'        "$LLAMA_LIB/libggml-blas.so"
# At least one CPU backend variant must be present (apple_m1/m2_m3/m4 cover
# all current Apple Silicon Macs).
if ! ls "$LLAMA_LIB/"libggml-cpu-apple_*.so >/dev/null 2>&1; then
  echo "FAIL [llama]: no libggml-cpu-apple_*.so backend plugin in $LLAMA_LIB/" >&2
  FAIL=1
else
  echo "ok   [llama]: libggml-cpu-apple_*.so plugin present ($(ls "$LLAMA_LIB/"libggml-cpu-apple_*.so | wc -l | tr -d ' ') variant(s))"
fi
check_no_homebrew_refs 'llama bundle' \
  "$LLAMA_BIN" \
  "$LLAMA_LIB/"*.dylib \
  "$LLAMA_LIB/"*.so

echo ""
if [ $FAIL -ne 0 ]; then
  echo "VERIFY FAILED — DMG would not work on Macs without Homebrew at /opt/homebrew." >&2
  exit 1
fi
echo "VERIFY OK — bundles are self-contained."
