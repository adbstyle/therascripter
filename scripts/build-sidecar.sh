#!/usr/bin/env bash
# Build merged PyInstaller sidecar binary (diarize + ner_service).
# Produces: python_sidecar/dist/ml_sidecar/{diarize, ner_service, _internal/}
# Requires: python_sidecar/venv with pyannote.audio + flair + pyinstaller installed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SIDECAR_DIR="$PROJECT_ROOT/python_sidecar"
VENV_DIR="$SIDECAR_DIR/venv"

# Check venv
if [ ! -d "$VENV_DIR" ]; then
  echo "Error: Python venv nicht gefunden: $VENV_DIR"
  echo "Setup: scripts/setup-pyannote.sh && scripts/setup-ner.sh"
  exit 1
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# Ensure PyInstaller is installed
if ! command -v pyinstaller &>/dev/null; then
  echo "PyInstaller nicht gefunden, wird installiert..."
  pip install pyinstaller
fi

# Clean previous build
echo "=== Cleaning previous build ==="
rm -rf "$SIDECAR_DIR/dist/ml_sidecar" "$SIDECAR_DIR/build/diarize" "$SIDECAR_DIR/build/ner_service"

# Build merged sidecar
echo "=== Building merged ml_sidecar ==="
cd "$SIDECAR_DIR"
pyinstaller ml_sidecar.spec --noconfirm

# Verify output
if [ ! -f "$SIDECAR_DIR/dist/ml_sidecar/diarize" ] || [ ! -f "$SIDECAR_DIR/dist/ml_sidecar/ner_service" ]; then
  echo "Error: Build fehlgeschlagen — Executables nicht gefunden"
  exit 1
fi

# Report sizes
echo ""
echo "=== Build erfolgreich ==="
echo "Executables:"
ls -lh "$SIDECAR_DIR/dist/ml_sidecar/diarize" "$SIDECAR_DIR/dist/ml_sidecar/ner_service"
echo ""
echo "_internal/:"
du -sh "$SIDECAR_DIR/dist/ml_sidecar/_internal/"
echo ""
echo "Gesamt:"
du -sh "$SIDECAR_DIR/dist/ml_sidecar/"
