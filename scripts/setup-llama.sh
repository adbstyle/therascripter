#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/resources/bin"
LIB_DIR="$REPO_ROOT/resources/lib"

# Gemma 4 E4B Q4_K_M GGUF was not yet published when this feature shipped — see
# CLAUDE.md ("Gemma 4 E4B GGUF source"). Fallback: Gemma 3 4B Instruct Q4_K_M.
# The repo is HuggingFace-gated → run `huggingface-cli login` before --model.
GGUF_FILENAME='gemma-3-4b-it-Q4_K_M.gguf'
GGUF_URL="https://huggingface.co/bartowski/gemma-3-4b-it-GGUF/resolve/main/${GGUF_FILENAME}"

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
cp "$BREW_PREFIX/lib/"libllama*.dylib "$LIB_DIR/" 2>/dev/null || true
cp "$BREW_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true

echo '==> Re-signing binary with ad-hoc signature'
codesign --force --sign - "$BIN_DIR/llama-cli"
for dylib in "$LIB_DIR/"libllama*.dylib "$LIB_DIR/"libggml*.dylib; do
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
    if command -v huggingface-cli >/dev/null 2>&1; then
      huggingface-cli download "bartowski/gemma-3-4b-it-GGUF" \
        "$GGUF_FILENAME" --local-dir "$MODEL_DIR" --local-dir-use-symlinks False
    else
      echo "huggingface-cli not found — falling back to direct curl (will fail if model is gated)" >&2
      curl -L --fail -o "$MODEL_FILE" "$GGUF_URL"
    fi
  else
    echo "Model already present: $MODEL_FILE"
  fi
  echo '==> SHA-256:'
  shasum -a 256 "$MODEL_FILE"
fi

echo '==> Done'
