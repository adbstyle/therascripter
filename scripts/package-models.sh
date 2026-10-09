#!/usr/bin/env bash
# Package ML model archives for R2 upload.
# Creates tar.gz archives in r2-upload/ and prints SHA-256 hashes.
#
# Usage: scripts/package-models.sh [all|ner]
#   ner  packt nur das NER-Artefakt. Wichtig beim Publizieren EINES neuen
#        Artefakts: ein Voll-Lauf packt auch pyannote-suite.tar.gz neu, dessen
#        Hash sich durch die gzip-Zeitstempel ändert — würde das hochgeladen,
#        brächen die eingebauten Katalog-Hashes ausgelieferter App-Versionen.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/r2-upload"
MODELS_DIR="$HOME/.therascript/models"
SIDECAR_PY="$PROJECT_ROOT/python_sidecar/venv/bin/python"
TARGET="${1:-all}"
case "$TARGET" in
  all|ner) ;;
  *) echo "FEHLER: unbekanntes Ziel '$TARGET' (erlaubt: all, ner)" >&2; exit 2 ;;
esac

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

if [ "$TARGET" = "all" ]; then
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
fi

# flair NER model (archive contents extracted INTO ner/)
#
# -v3 (Issue #131): fp16-Checkpoint, von scripts/convert-ner-fp16.py an die
# Stelle des Original-Blobs geschrieben (Begründung dort). Neuer Dateiname statt
# Overwrite: ausgelieferte App-Versionen verifizieren First-Launch-Downloads
# gegen ihre EINGEBAUTEN Katalog-Hashes. v1 und v2 bleiben auf R2 liegen, bis
# keine App-Version mehr darauf zeigt.
#
# Gepackt wird eine Staging-Kopie, nie ner/ selbst: dort liegen lokal auch der
# fp32-Original-Blob und ggf. eine ~2.1 GB grosse Fast-Kopie (*-fast.pt).
#
# Ohne `|| exit 1` aufgerufen: in einem ||-Kontext ignoriert bash errexit für
# den GANZEN Funktionsrumpf — ein an voller Platte gescheitertes tar lieferte
# dann still Hash und Grösse eines abgeschnittenen Tarballs.
# Der trap räumt auch das .partial weg: sonst lädt upload-r2.sh ohne Argumente
# (sidecar:deploy) ein abgeschnittenes Tarball hoch, und die Hash-Liste unten
# gäbe es als zu kopierenden Katalogwert aus.
NER_OUTPUT_NAME="flair-ner-german-large-v3.tar.gz"
NER_STAGING=""
cleanup_ner() {
  [ -n "$NER_STAGING" ] && rm -rf "$NER_STAGING"
  rm -f "$OUTPUT_DIR/$NER_OUTPUT_NAME.partial"
}
trap cleanup_ner EXIT

package_ner() {
  local SRC="$MODELS_DIR/ner"

  if [ ! -d "$SRC" ]; then
    if [ "$TARGET" = "ner" ]; then
      echo "  FEHLER: flair-Modell nicht gefunden: $SRC" >&2
      exit 1
    fi
    echo "  SKIP: flair-Modell nicht gefunden: $SRC"
    return 0
  fi
  if [ ! -d "$SRC/hf/hub/models--xlm-roberta-large" ]; then
    echo "  FEHLER: ner/hf/-Tokenizer-Subtree fehlt — zuerst scripts/setup-ner.sh --model ausführen." >&2
    exit 1
  fi
  if [ ! -x "$SIDECAR_PY" ]; then
    echo "  FEHLER: $SIDECAR_PY fehlt — zuerst scripts/setup-ner.sh ausführen." >&2
    exit 1
  fi

  NER_STAGING=$(mktemp -d)
  # Struktur samt Snapshot-Symlink und hf/, aber ohne Blobs der Modell-Repos
  # (der Konverter schreibt den einen fp16-Blob) und ohne Fast-Kopien
  # (Suffix FAST_CHECKPOINT_SUFFIX in ner_service.py).
  rsync -a --exclude '.DS_Store' --exclude '*-fast.pt' --exclude '*-fast.pt.*.tmp' \
    --exclude '/models/*/models--*/blobs/*' "$SRC/" "$NER_STAGING/"
  PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" "$SCRIPT_DIR/convert-ner-fp16.py" "$SRC" "$NER_STAGING"

  # Erst in eine .partial schreiben: ein abgebrochener Lauf hinterlässt nie ein
  # Tarball unter dem finalen Namen, das upload-r2.sh hochladen könnte.
  tar -czf "$OUTPUT_DIR/$NER_OUTPUT_NAME.partial" -C "$NER_STAGING" .
  mv "$OUTPUT_DIR/$NER_OUTPUT_NAME.partial" "$OUTPUT_DIR/$NER_OUTPUT_NAME"
  rm -rf "$NER_STAGING"
  NER_STAGING=""
  echo "  -> $NER_OUTPUT_NAME"
}

package_ner

echo ""
echo "=== Sizes ==="
ls -lh "$OUTPUT_DIR/"

echo ""
echo "=== SHA-256 Hashes ==="
echo "(Copy these into src/shared/model-catalog.ts)"
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
