#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/resources/bin"
LIB_DIR="$REPO_ROOT/resources/lib"

# Gemma 4 E4B Q4_K_M GGUF was not yet published when this feature shipped — see
# CLAUDE.md ("Gemma 4 E4B GGUF source"). Fallback: Gemma 3 4B Instruct Q4_K_M.
# The repo is HuggingFace-gated → run `huggingface-cli login` before --model.
GGUF_FILENAME='google_gemma-3-4b-it-Q4_K_M.gguf'
GGUF_REPO='bartowski/google_gemma-3-4b-it-GGUF'
GGUF_URL="https://huggingface.co/${GGUF_REPO}/resolve/main/${GGUF_FILENAME}"

mkdir -p "$BIN_DIR" "$LIB_DIR"

echo '==> Installing llama.cpp via Homebrew'
if ! command -v brew >/dev/null 2>&1; then
  echo 'Homebrew is required. Install from https://brew.sh' >&2
  exit 1
fi
brew install llama.cpp

BREW_PREFIX="$(brew --prefix llama.cpp)"
echo '==> Copying llama-cli binary'
cp "$BREW_PREFIX/bin/llama-cli" "$BIN_DIR/llama-cli"

echo '==> Copying runtime dylibs'
# llama-cli (>= b8920) links against libllama, libllama-common and libmtmd
# from the llama.cpp formula plus libggml + libggml-base from the ggml
# formula (separate Homebrew install). Copy all of them.
cp "$BREW_PREFIX/lib/"libllama*.dylib "$LIB_DIR/" 2>/dev/null || true
cp "$BREW_PREFIX/lib/"libmtmd*.dylib "$LIB_DIR/" 2>/dev/null || true
GGML_PREFIX="$(brew --prefix ggml 2>/dev/null || true)"
if [ -n "$GGML_PREFIX" ] && [ -d "$GGML_PREFIX/lib" ]; then
  cp "$GGML_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true
fi
# Fallback: some older formulas ship libggml in the llama.cpp prefix.
cp "$BREW_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true

# Sanity check: the copy commands above use `|| true` to be tolerant of layout
# variations across Homebrew versions. Without this guard a successful run
# could leave $LIB_DIR empty and the bug would only surface at runtime as a
# `dyld: Library not loaded` crash.
have_libllama=$(ls -1 "$LIB_DIR/"libllama*.dylib 2>/dev/null | wc -l | tr -d ' ')
have_libggml=$(ls -1 "$LIB_DIR/"libggml*.dylib 2>/dev/null | wc -l | tr -d ' ')
if [ "$have_libllama" -eq 0 ] || [ "$have_libggml" -eq 0 ]; then
  echo "FATAL: required dylibs missing in $LIB_DIR (libllama=$have_libllama libggml=$have_libggml)" >&2
  echo "  Check 'brew --prefix llama.cpp' and 'brew --prefix ggml' layouts." >&2
  exit 1
fi

echo '==> Re-signing binary with ad-hoc signature'
codesign --force --sign - "$BIN_DIR/llama-cli"
for dylib in "$LIB_DIR/"libllama*.dylib "$LIB_DIR/"libmtmd*.dylib "$LIB_DIR/"libggml*.dylib; do
  [ -f "$dylib" ] && codesign --force --sign - "$dylib"
done

echo '==> Verifying binary'
"$BIN_DIR/llama-cli" --version

if [[ "${1:-}" == '--model' ]]; then
  MODEL_DIR="$HOME/.therascript/models/summarization"
  mkdir -p "$MODEL_DIR"
  MODEL_FILE="$MODEL_DIR/$GGUF_FILENAME"
  if [ ! -f "$MODEL_FILE" ]; then
    echo "==> Downloading Gemma 3 4B Instruct Q4_K_M (~2.5 GB)"
    # Prefer the new `hf` CLI (huggingface-hub >=0.26); fall back to the legacy
    # `huggingface-cli` for older installs, then to a direct curl (which fails
    # for gated repos like bartowski/gemma-3-4b-it-GGUF).
    if command -v hf >/dev/null 2>&1; then
      hf download "$GGUF_REPO" "$GGUF_FILENAME" --local-dir "$MODEL_DIR"
    elif command -v huggingface-cli >/dev/null 2>&1; then
      huggingface-cli download "$GGUF_REPO" \
        "$GGUF_FILENAME" --local-dir "$MODEL_DIR" --local-dir-use-symlinks False
    else
      echo "Neither hf nor huggingface-cli found — falling back to direct curl (will fail if gated)" >&2
      curl -L --fail -o "$MODEL_FILE" "$GGUF_URL"
    fi
  else
    echo "Model already present: $MODEL_FILE"
  fi
  echo '==> SHA-256:'
  shasum -a 256 "$MODEL_FILE"
fi

echo '==> Done'
