#!/usr/bin/env bash
# Konvertiert ein HuggingFace-Whisper-Modell in ggml-q5_0 für whisper.cpp.
#
# Voraussetzungen:
#   - git, python3 (3.10+), pip, cmake
#   - huggingface-cli eingeloggt (falls Modell gated)
#
# Usage:
#   scripts/convert-hf-whisper.sh <hf-repo> <output-basename>
# Beispiel:
#   scripts/convert-hf-whisper.sh Flurin17/whisper-large-v3-turbo-swiss-german \
#     whisper-ggml-large-v3-turbo-swiss-q5_0
#
# Output: r2-upload/<output-basename>.bin (quantisiert, hochladebereit)

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <hf-repo> <output-basename>" >&2
  exit 1
fi

HF_REPO="$1"
OUT_NAME="$2"

# Python 3.14 is too new for current torch wheels → default to 3.12, allow override.
PYTHON_BIN="${PYTHON_BIN:-python3.12}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: $PYTHON_BIN nicht gefunden. Setze PYTHON_BIN=python3.x explizit." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WORK_DIR="$PROJECT_ROOT/build/convert-hf-whisper"
OUT_DIR="$PROJECT_ROOT/r2-upload"
WHISPER_CPP_DIR="$WORK_DIR/whisper.cpp"
OPENAI_WHISPER_DIR="$WORK_DIR/openai-whisper"
MODEL_DIR="$WORK_DIR/hf-model"

mkdir -p "$WORK_DIR" "$OUT_DIR"

# 1a. whisper.cpp clonen (Konvertierungs-Script + quantize-Tool)
if [ ! -d "$WHISPER_CPP_DIR" ]; then
  echo "-> Klone whisper.cpp nach $WHISPER_CPP_DIR"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_CPP_DIR"
fi

# 1b. openai/whisper-Repo clonen - convert-h5-to-ggml.py erwartet das
#     als zweites Argument (Quelle: Mel-Filter-Assets + Tokenizer-Artefakte).
if [ ! -d "$OPENAI_WHISPER_DIR" ]; then
  echo "-> Klone openai/whisper nach $OPENAI_WHISPER_DIR"
  git clone --depth 1 https://github.com/openai/whisper "$OPENAI_WHISPER_DIR"
fi

# 2. Python-Deps in ein venv, um System-Python nicht zu verschmutzen
VENV="$WORK_DIR/venv"
if [ ! -d "$VENV" ]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet torch transformers huggingface_hub

# 3. HF-Modell herunterladen
if [ ! -d "$MODEL_DIR/$(basename "$HF_REPO")" ]; then
  echo "-> Lade $HF_REPO herunter"
  mkdir -p "$MODEL_DIR"
  huggingface-cli download "$HF_REPO" \
    --local-dir "$MODEL_DIR/$(basename "$HF_REPO")" \
    --local-dir-use-symlinks False
fi

# 4. ggml-Conversion. Script legt ggml-model.bin in $WORK_DIR ab.
GGML_RAW="$WORK_DIR/$OUT_NAME-raw.bin"
echo "-> Konvertiere nach ggml"
python "$WHISPER_CPP_DIR/models/convert-h5-to-ggml.py" \
  "$MODEL_DIR/$(basename "$HF_REPO")" \
  "$OPENAI_WHISPER_DIR" \
  "$WORK_DIR"
mv "$WORK_DIR/ggml-model.bin" "$GGML_RAW"

# 5. whisper.cpp bauen (ohne --target, weil der Binary-Name je Version
#    zwischen `quantize` und `whisper-quantize` wechselt).
if [ ! -d "$WHISPER_CPP_DIR/build" ]; then
  echo "-> Baue whisper.cpp"
  (cd "$WHISPER_CPP_DIR" && cmake -B build && cmake --build build -j)
fi

# 6. Quantize-Binary finden (Name variiert nach whisper.cpp-Version)
QUANTIZE_BIN=""
for candidate in "$WHISPER_CPP_DIR/build/bin/quantize" \
                 "$WHISPER_CPP_DIR/build/bin/whisper-quantize"; do
  if [ -x "$candidate" ]; then
    QUANTIZE_BIN="$candidate"
    break
  fi
done
if [ -z "$QUANTIZE_BIN" ]; then
  echo "Error: quantize-Binary nicht gefunden in $WHISPER_CPP_DIR/build/bin/" >&2
  ls "$WHISPER_CPP_DIR/build/bin/" >&2
  exit 1
fi

# 7. Quantisierung -> q5_0
echo "-> Quantisiere q5_0 via $QUANTIZE_BIN"
"$QUANTIZE_BIN" "$GGML_RAW" "$OUT_DIR/$OUT_NAME.bin" q5_0

# 8. SHA-256 + Groesse ausgeben
HASH=$(shasum -a 256 "$OUT_DIR/$OUT_NAME.bin" | cut -d' ' -f1)
SIZE=$(stat -f%z "$OUT_DIR/$OUT_NAME.bin")
echo ""
echo "=== Fertig ==="
echo "Datei:     $OUT_DIR/$OUT_NAME.bin"
echo "SHA-256:   $HASH"
echo "Groesse:   $SIZE bytes"
echo ""
echo "Naechste Schritte:"
echo "  1. sha256 + sizeBytes in MODEL_DEFINITIONS (ModelDownloadService.ts) eintragen"
echo "  2. scripts/publish-manifest.sh laufen lassen (laedt nach R2)"
