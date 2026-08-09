#!/usr/bin/env bash
#
# Setup whisper.cpp binary and model for development.
# Installs pre-built whisper-cpp via Homebrew (no C++ toolchain needed).
#
# Produces:
#   resources/whisper/bin/whisper-cli
#   resources/whisper/lib/libwhisper.*.dylib + libggml-*.dylib
#   ~/.therascript/models/asr/ggml-large-v3-turbo-q5_0.bin (optional, with --model)
#
# Bundle layout rationale: whisper.cpp and llama.cpp link against incompatible
# ggml generations (see CLAUDE.md gotcha "whisper.cpp und llama.cpp linken
# gegen inkompatible ggml-Generationen"). The two toolchains live
# in separate self-contained directories — each binary's built-in
# LC_RPATH=@loader_path/../lib resolves to the tool-specific lib/ sibling.
#
# Usage:
#   ./scripts/setup-whisper.sh          # binary + dylibs only
#   ./scripts/setup-whisper.sh --model  # also download the ASR model (~547 MB)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_ROOT/resources/whisper/bin"
LIB_DIR="$PROJECT_ROOT/resources/whisper/lib"
MODEL_DIR="$HOME/.therascript/models/asr"

# Migrations-Cleanup: remove the previous shared layout if a developer is
# upgrading from before the ggml ABI split. Only deletes whisper's
# share of resources/lib (libwhisper.* + libggml*) and the old whisper-cli
# binary — never touches the llama bundle, ffmpeg, or vision-ocr.
rm -f \
  "$PROJECT_ROOT/resources/bin/whisper-cli" \
  "$PROJECT_ROOT/resources/lib/"libwhisper.*.dylib \
  "$PROJECT_ROOT/resources/lib/"libggml*.dylib 2>/dev/null || true
MODEL_FILE="ggml-large-v3-turbo-q5_0.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"

DOWNLOAD_MODEL=false
for arg in "$@"; do
  case "$arg" in
    --model) DOWNLOAD_MODEL=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── 1. Install whisper-cpp via Homebrew ──────────────────────────────────────

if ! command -v brew &>/dev/null; then
  echo "Error: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

if ! brew list whisper-cpp &>/dev/null; then
  echo "Installing whisper-cpp via Homebrew..."
  brew install whisper-cpp
else
  echo "whisper-cpp already installed ($(brew info whisper-cpp --json | grep -o '"version":"[^"]*"' | head -1))"
fi

WHISPER_PREFIX="$(brew --prefix whisper-cpp)/libexec"

# ── 2. Copy binary ──────────────────────────────────────────────────────────

mkdir -p "$BIN_DIR"
cp "$WHISPER_PREFIX/bin/whisper-cli" "$BIN_DIR/whisper-cli"
echo "Binary: $BIN_DIR/whisper-cli"

# ── 3. Copy dylibs (whisper-cli uses @rpath → @loader_path/../lib) ──────────

mkdir -p "$LIB_DIR"

DYLIBS=(
  libwhisper.1.dylib
  libggml.0.dylib
  libggml-base.0.dylib
  libggml-cpu.0.dylib
  libggml-blas.0.dylib
  libggml-metal.0.dylib
)

for lib in "${DYLIBS[@]}"; do
  if [ -f "$WHISPER_PREFIX/lib/$lib" ]; then
    cp "$WHISPER_PREFIX/lib/$lib" "$LIB_DIR/$lib"
  else
    echo "Warning: $lib not found, skipping (may not be needed)"
  fi
done
echo "Libraries: $LIB_DIR/ ($(ls "$LIB_DIR" | wc -l | tr -d ' ') files)"

# ── 3a. Make bundle self-contained ──────────────────────────────────────────
# whisper-cpp's bundled dylibs ship with absolute LC_ID install names pointing
# into Homebrew's prefix (e.g. /opt/homebrew/opt/whisper-cpp/libexec/lib/…).
# whisper-cli's inter-dylib refs are already @rpath, so the bundle works on a
# Homebrew-equipped Mac — but on an end-user Mac dyld dedup behaviour around
# absolute LC_IDs can bite. Rewrite every Mach-O so the bundle is fully
# location-independent. Must run before codesign re-sign below; install_name_tool
# invalidates the Mach-O signature.

echo "Rewriting absolute /opt/homebrew references to @rpath"
# shellcheck source=lib/rewrite-macho.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/rewrite-macho.sh"
rewrite_macho "$BIN_DIR/whisper-cli" binary
for dylib in "$LIB_DIR/"*.dylib; do
  rewrite_macho "$dylib" dylib
done
if otool -L "$BIN_DIR/whisper-cli" "$LIB_DIR/"*.dylib | grep '/opt/homebrew'; then
  echo "FATAL: bundle still references /opt/homebrew after rewrite" >&2
  exit 1
fi

# Re-sign every Mach-O ad-hoc (install_name_tool invalidated the signature).
codesign --force --sign - "$BIN_DIR/whisper-cli"
for dylib in "$LIB_DIR/"*.dylib; do
  codesign --force --sign - "$dylib"
done

# ── 4. Verify binary works ──────────────────────────────────────────────────

if "$BIN_DIR/whisper-cli" --help &>/dev/null; then
  echo "Verification: whisper-cli OK"
else
  echo "Error: whisper-cli failed to run. Check dylib dependencies:"
  otool -L "$BIN_DIR/whisper-cli"
  exit 1
fi

# ── 5. Download model (optional) ────────────────────────────────────────────

if [ "$DOWNLOAD_MODEL" = true ]; then
  mkdir -p "$MODEL_DIR"
  if [ -f "$MODEL_DIR/$MODEL_FILE" ]; then
    echo "Model already exists: $MODEL_DIR/$MODEL_FILE"
  else
    echo "Downloading model (~547 MB)..."
    curl -L --progress-bar -o "$MODEL_DIR/$MODEL_FILE" "$MODEL_URL"
    echo "Model: $MODEL_DIR/$MODEL_FILE"
  fi
fi

echo ""
echo "=== Setup complete ==="
echo ""
if [ "$DOWNLOAD_MODEL" = false ] && [ ! -f "$MODEL_DIR/$MODEL_FILE" ]; then
  echo "To download the ASR model, run:"
  echo "  ./scripts/setup-whisper.sh --model"
fi
