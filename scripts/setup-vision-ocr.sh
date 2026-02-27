#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SWIFT_DIR="$PROJECT_DIR/swift_cli/vision_ocr"
BIN_DIR="$PROJECT_DIR/resources/bin"

echo "Building Swift Vision OCR CLI..."

if ! command -v swift &>/dev/null; then
  echo "Error: Swift is not installed. Please install Xcode or Xcode Command Line Tools."
  exit 1
fi

cd "$SWIFT_DIR"

swift build -c release --arch arm64 2>&1

mkdir -p "$BIN_DIR"
cp .build/release/vision-ocr "$BIN_DIR/vision-ocr"
chmod +x "$BIN_DIR/vision-ocr"

echo "Vision OCR CLI installed -> resources/bin/vision-ocr"
