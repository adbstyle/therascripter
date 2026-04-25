#!/usr/bin/env bash
# Package ML model archives for R2 upload.
# Creates tar.gz archives in r2-upload/ and prints SHA-256 hashes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/r2-upload"
MODELS_DIR="$HOME/.therascript/models"

# Pyannote-Suite Packaging.
#
# pyannote 4.x lädt hardcoded die PLDA-Files aus pyannote/speaker-diarization-community-1,
# auch wenn die aktive Pipeline 3.1 ist (siehe speaker_diarization.py:206-231 in der
# installierten pyannote.audio-Version). Deshalb müssen BEIDE Pipelines + ihre
# Sub-Models zusammen ausgeliefert werden — ein User-Toggle zwischen 3.1 und community-1
# ist nur eine Runtime-Konfiguration, keine separate Installation.
#
# Wir packen die vier benötigten HF-Cache-Ordner in ein einziges Tarball:
#   - models--pyannote--speaker-diarization-3.1/
#   - models--pyannote--speaker-diarization-community-1/
#   - models--pyannote--segmentation-3.0/            (referenziert von 3.1)
#   - models--pyannote--wespeaker-voxceleb-resnet34-LM/  (referenziert von 3.1)
#
# Bricht mit exit 1 ab, wenn einer der vier Ordner im Cache fehlt.
package_pyannote_suite() {
  local OUTPUT_NAME="pyannote-suite.tar.gz"
  local REQUIRED=(
    models--pyannote--speaker-diarization-3.1
    models--pyannote--speaker-diarization-community-1
    models--pyannote--segmentation-3.0
    models--pyannote--wespeaker-voxceleb-resnet34-LM
  )

  local TMP_DIR
  TMP_DIR=$(mktemp -d)

  for SUB in "${REQUIRED[@]}"; do
    local SRC="$MODELS_DIR/diarization/$SUB"
    if [ ! -d "$SRC" ]; then
      echo "  FEHLER: $SUB fehlt im Cache — pyannote-Suite braucht alle vier Sub-Modelle." >&2
      echo "          Bitte zuerst scripts/setup-pyannote.sh --all-models ausführen." >&2
      rm -rf "$TMP_DIR"
      return 1
    fi
    cp -R "$SRC" "$TMP_DIR/"
  done

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

# Pyannote-Suite — monolithisches Paket mit allen vier benötigten Sub-Modellen
package_pyannote_suite || exit 1

# NER-Tarballs werden mit expliziten Includes gepackt, damit beide Modelle
# (flair, ai4privacy) friedlich unter $MODELS_DIR/ner/ koexistieren können
# ohne dass eine Tarball-Erstellung Inhalte des jeweils anderen mitschleppt.

# flair NER model (extrahiert nach ner/models/ner-german-large)
FLAIR_SUBDIR="models/ner-german-large"
if [ -d "$MODELS_DIR/ner/$FLAIR_SUBDIR" ]; then
  tar -czf "$OUTPUT_DIR/flair-ner-german-large.tar.gz" \
    -C "$MODELS_DIR/ner" "$FLAIR_SUBDIR"
  echo "  -> flair-ner-german-large.tar.gz"
else
  echo "  SKIP: flair-Modell nicht gefunden: $MODELS_DIR/ner/$FLAIR_SUBDIR"
fi

# ai4privacy NER model (HF-Cache-Layout, extrahiert nach ner/models--ai4privacy--…)
AI4PRIVACY_SUBDIR="models--ai4privacy--llama-ai4privacy-multilingual-categorical-anonymiser-openpii"
if [ -d "$MODELS_DIR/ner/$AI4PRIVACY_SUBDIR" ]; then
  tar -czf "$OUTPUT_DIR/ai4privacy-openpii-modernbert.tar.gz" \
    -C "$MODELS_DIR/ner" "$AI4PRIVACY_SUBDIR"
  echo "  -> ai4privacy-openpii-modernbert.tar.gz"
else
  echo "  SKIP: ai4privacy-Modell nicht gefunden: $MODELS_DIR/ner/$AI4PRIVACY_SUBDIR"
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
