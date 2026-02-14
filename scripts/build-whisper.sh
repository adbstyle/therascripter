#!/usr/bin/env bash
#
# Build whisper.cpp for ARM64 macOS with Metal GPU support.
# Produces: resources/bin/whisper-cli
#
# Usage: ./scripts/build-whisper.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_ROOT/.whisper-build"
OUTPUT_DIR="$PROJECT_ROOT/resources/bin"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"

echo "=== Building whisper.cpp for ARM64 + Metal ==="

# Clone or update
if [ -d "$BUILD_DIR/whisper.cpp" ]; then
  echo "Updating existing whisper.cpp clone..."
  cd "$BUILD_DIR/whisper.cpp"
  git pull --ff-only
else
  echo "Cloning whisper.cpp..."
  mkdir -p "$BUILD_DIR"
  cd "$BUILD_DIR"
  git clone --depth 1 "$WHISPER_REPO"
  cd whisper.cpp
fi

# Build with Metal support
echo "Building with Metal support..."
cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_METAL=ON \
  -DCMAKE_OSX_ARCHITECTURES=arm64

cmake --build build --config Release -j "$(sysctl -n hw.ncpu)"

# Copy binary
mkdir -p "$OUTPUT_DIR"
cp build/bin/whisper-cli "$OUTPUT_DIR/whisper-cli"

echo ""
echo "=== Build complete ==="
echo "Binary: $OUTPUT_DIR/whisper-cli"
echo ""
echo "To download the model, run:"
echo "  mkdir -p ~/.therascript/models/asr"
echo "  curl -L -o ~/.therascript/models/asr/ggml-large-v3-turbo-q5_0.bin \\"
echo "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
