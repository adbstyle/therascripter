#!/usr/bin/env bash
#
# Setup Python NER service with flair.
# Reuses the existing venv created by setup-pyannote.sh.
#
# Produces:
#   python_sidecar/venv/                (Python venv extended with flair)
#   ~/.therascript/models/ner/          (flair model cache, with --model)
#
# Usage:
#   ./scripts/setup-ner.sh          # install flair into existing venv
#   ./scripts/setup-ner.sh --model  # also download flair-ner-german-large model (~2.2 GB)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_ROOT/python_sidecar/venv"
MODEL_DIR="$HOME/.therascript/models/ner"
REQUIREMENTS="$PROJECT_ROOT/python_sidecar/requirements-ner.txt"

DOWNLOAD_MODEL=false
for arg in "$@"; do
  case "$arg" in
    --model) DOWNLOAD_MODEL=true ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── 1. Check venv exists ─────────────────────────────────────────────────────

if [ ! -d "$VENV_DIR" ]; then
  echo "Error: Virtual environment not found at $VENV_DIR"
  echo "Run scripts/setup-pyannote.sh first to create the venv."
  exit 1
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# ── 2. Install NER dependencies ──────────────────────────────────────────────

echo "Installing NER dependencies (flair)..."
pip install --upgrade pip --quiet
pip install -r "$REQUIREMENTS" --quiet

echo "Dependencies installed."

# ── 3. Verify installation ───────────────────────────────────────────────────

python3 -c "import flair; print(f'flair {flair.__version__}')"
python3 -c "import torch; print(f'PyTorch {torch.__version__} (MPS: {torch.backends.mps.is_available()})')"

# ── 4. Download model (optional) ────────────────────────────────────────────

if [ "$DOWNLOAD_MODEL" = true ]; then
  mkdir -p "$MODEL_DIR"
  echo "Downloading flair/ner-german-large model (~2.2 GB)..."
  echo "This may take several minutes depending on your connection."
  echo ""

  # HF_HOME="$MODEL_DIR/hf": Der xlm-roberta-large-Tokenizer (~14 MB) wird von
  # flair beim Modell-Load OHNE explizites cache_dir über huggingface_hub
  # aufgelöst — ohne HF_HOME landet er in ~/.cache/huggingface und fehlt dann
  # im gepackten Artefakt (Endnutzer-Macs haben keinen HF-Cache; ner_service.py
  # setzt HF_HOME zur Laufzeit auf denselben Pfad).
  FLAIR_CACHE_ROOT="$MODEL_DIR" HF_HOME="$MODEL_DIR/hf" python3 -c "
from flair.nn import Classifier
import os

model_dir = os.environ.get('FLAIR_CACHE_ROOT', '$MODEL_DIR')
print(f'Cache directory: {model_dir}')
print(f'HF_HOME (Tokenizer-Cache): {os.environ[\"HF_HOME\"]}')
print('Loading flair/ner-german-large (will download if not cached)...')

try:
    tagger = Classifier.load('flair/ner-german-large')
    print('Model downloaded and loaded successfully.')
except Exception as e:
    print(f'Error: {e}')
    exit(1)
"
fi

deactivate

echo ""
echo "=== NER Setup complete ==="
echo ""
echo "Virtual environment: $VENV_DIR"
if [ "$DOWNLOAD_MODEL" = false ]; then
  echo ""
  echo "To download the NER model (~2.2 GB), run:"
  echo "  ./scripts/setup-ner.sh --model"
fi
