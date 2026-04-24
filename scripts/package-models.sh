#!/usr/bin/env bash
# Package ML model archives for R2 upload.
# Creates tar.gz archives in r2-upload/ and prints SHA-256 hashes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/r2-upload"
MODELS_DIR="$HOME/.therascript/models"

# Liest aus einem pyannote-Pipeline-config.yaml die referenzierten Sub-Model-Slugs
# (z.B. "pyannote/segmentation-3.0" → "models--pyannote--segmentation-3.0").
# Gibt die HuggingFace-Cache-Dir-Namen zeilenweise auf stdout aus.
pyannote_submodel_dirs() {
  local CONFIG="$1"
  [ -f "$CONFIG" ] || return 0
  grep -E '^\s+(embedding|segmentation):' "$CONFIG" \
    | awk '{print $2}' \
    | sed 's|/|--|g' \
    | sed 's|^|models--|'
}

# Bündelt ein pyannote-Modell + ALLE aus dessen config.yaml referenzierten Sub-Models in ein Tarball.
# Bricht mit exit 1 ab, wenn ein referenziertes Sub-Model im Cache fehlt (CSP connect-src 'none'
# verhindert Lazy-Download zur Runtime — ein fehlendes Sub-Model würde Diarization silent crashen).
package_pyannote_model() {
  local MODEL_SLUG="$1"      # z.B. "pyannote/speaker-diarization-3.1"
  local OUTPUT_NAME="$2"     # z.B. "pyannote-speaker-diarization-3.1.tar.gz"

  local CACHE_DIR_NAME
  CACHE_DIR_NAME="models--$(echo "$MODEL_SLUG" | sed 's|/|--|g')"
  local CACHE_DIR="$MODELS_DIR/diarization/$CACHE_DIR_NAME"

  if [ ! -d "$CACHE_DIR" ]; then
    echo "  SKIP: $MODEL_SLUG nicht im Cache: $CACHE_DIR"
    return 0
  fi

  local CONFIG
  CONFIG=$(find "$CACHE_DIR/snapshots" \( -name config.yaml -type f -o -name config.yaml -type l \) 2>/dev/null | head -n1)
  if [ -z "$CONFIG" ]; then
    echo "  FEHLER: keine config.yaml in $CACHE_DIR/snapshots/" >&2
    return 1
  fi

  local TMP_DIR
  TMP_DIR=$(mktemp -d)
  cp -R "$CACHE_DIR" "$TMP_DIR/"

  # Referenzierte Sub-Models zwingend bundeln — sonst hart fehlschlagen
  while IFS= read -r SUB_DIR; do
    [ -z "$SUB_DIR" ] && continue
    local SRC="$MODELS_DIR/diarization/$SUB_DIR"
    if [ ! -d "$SRC" ]; then
      echo "  FEHLER: $MODEL_SLUG referenziert $SUB_DIR — aber $SRC fehlt." >&2
      echo "          Bitte zuerst scripts/setup-pyannote.sh für die fehlenden Sub-Models ausführen." >&2
      rm -rf "$TMP_DIR"
      return 1
    fi
    cp -R "$SRC" "$TMP_DIR/"
  done < <(pyannote_submodel_dirs "$CONFIG")

  tar -czf "$OUTPUT_DIR/$OUTPUT_NAME" -C "$TMP_DIR" .
  rm -rf "$TMP_DIR"
  echo "  -> $OUTPUT_NAME"
}

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "=== Packaging model archives ==="

# Whisper model (flat file, no tar.gz needed)
WHISPER_MODEL="$MODELS_DIR/asr/ggml-large-v3-turbo-q5_0.bin"
if [ -f "$WHISPER_MODEL" ]; then
  cp "$WHISPER_MODEL" "$OUTPUT_DIR/whisper-ggml-large-v3-turbo-q5_0.bin"
  echo "  -> whisper-ggml-large-v3-turbo-q5_0.bin"
else
  echo "  SKIP: Whisper-Modell nicht gefunden: $WHISPER_MODEL"
fi

# Whisper Swiss-German (flat file, optional)
WHISPER_SWISS="$MODELS_DIR/asr/ggml-large-v3-turbo-swiss-q5_0.bin"
if [ -f "$WHISPER_SWISS" ]; then
  cp "$WHISPER_SWISS" "$OUTPUT_DIR/whisper-ggml-large-v3-turbo-swiss-q5_0.bin"
  echo "  -> whisper-ggml-large-v3-turbo-swiss-q5_0.bin"
fi

# Pyannote Diarization 3.1 — isolierter Snapshot + shared sub-models
package_pyannote_model "pyannote/speaker-diarization-3.1" \
  "pyannote-speaker-diarization-3.1.tar.gz" || exit 1

# Pyannote Community-1 — isolierter Snapshot + shared sub-models
package_pyannote_model "pyannote/speaker-diarization-community-1" \
  "pyannote-speaker-diarization-community-1.tar.gz" || exit 1

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
