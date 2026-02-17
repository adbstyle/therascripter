#!/usr/bin/env bash
# Package sidecar binary + model archives for R2 upload.
# Creates tar.gz archives in r2-upload/ and prints SHA-256 hashes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/r2-upload"
SIDECAR_DIST="$PROJECT_ROOT/python_sidecar/dist/ml_sidecar"
MODELS_DIR="$HOME/.therascript/models"

# Verify sidecar build exists
if [ ! -f "$SIDECAR_DIST/diarize" ] || [ ! -f "$SIDECAR_DIST/ner_service" ]; then
  echo "Error: Sidecar-Build nicht gefunden. Zuerst: npm run sidecar:build"
  exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "=== Packaging sidecar binary ==="
# Package ml_sidecar (sidecar binary + _internal/)
tar -czf "$OUTPUT_DIR/ml-sidecar-arm64.tar.gz" -C "$PROJECT_ROOT/python_sidecar/dist" ml_sidecar
echo "  -> ml-sidecar-arm64.tar.gz"

echo "=== Packaging model archives ==="

# Whisper model (flat file, no tar.gz needed)
WHISPER_MODEL="$MODELS_DIR/asr/ggml-large-v3-turbo-q5_0.bin"
if [ -f "$WHISPER_MODEL" ]; then
  cp "$WHISPER_MODEL" "$OUTPUT_DIR/whisper-ggml-large-v3-turbo-q5_0.bin"
  echo "  -> whisper-ggml-large-v3-turbo-q5_0.bin"
else
  echo "  SKIP: Whisper-Modell nicht gefunden: $WHISPER_MODEL"
fi

# Pyannote models (archive contents extracted INTO diarization/)
if [ -d "$MODELS_DIR/diarization" ]; then
  tar -czf "$OUTPUT_DIR/pyannote-models.tar.gz" -C "$MODELS_DIR/diarization" .
  echo "  -> pyannote-models.tar.gz"
else
  echo "  SKIP: Pyannote-Modelle nicht gefunden: $MODELS_DIR/diarization"
fi

# flair NER model (archive contents extracted INTO ner/)
if [ -d "$MODELS_DIR/ner" ]; then
  tar -czf "$OUTPUT_DIR/flair-ner-german-large.tar.gz" -C "$MODELS_DIR/ner" .
  echo "  -> flair-ner-german-large.tar.gz"
else
  echo "  SKIP: flair-Modell nicht gefunden: $MODELS_DIR/ner"
fi

echo ""
echo "=== Sizes ==="
ls -lh "$OUTPUT_DIR/"

echo ""
echo "=== SHA-256 Hashes ==="
echo "(Copy these into ModelDownloadService.ts)"
echo ""
for f in "$OUTPUT_DIR"/*; do
  [ -f "$f" ] || continue
  NAME=$(basename "$f")
  HASH=$(shasum -a 256 "$f" | cut -d' ' -f1)
  SIZE=$(stat -f%z "$f")
  echo "  $NAME"
  echo "    sha256: '$HASH'"
  echo "    sizeBytes: $SIZE"
  echo ""
done
