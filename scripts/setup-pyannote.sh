#!/usr/bin/env bash
#
# Setup Python sidecar for pyannote.audio speaker diarization.
# Creates a virtual environment and installs dependencies.
#
# Produces:
#   python_sidecar/venv/     (Python venv with pyannote.audio + torch)
#   ~/.therascript/models/diarization/  (pyannote model files, with --model)
#
# Usage:
#   ./scripts/setup-pyannote.sh          # venv + deps only
#   ./scripts/setup-pyannote.sh --model  # also download the diarization model (~1.5 GB with torch deps)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$PROJECT_ROOT/python_sidecar/venv"
MODEL_DIR="$HOME/.therascript/models/diarization"
REQUIREMENTS="$PROJECT_ROOT/python_sidecar/requirements.txt"

MODEL_IDS=()
for arg in "$@"; do
  case "$arg" in
    --model) MODEL_IDS+=("pyannote/speaker-diarization-3.1") ;;
    --model-community) MODEL_IDS+=("pyannote/speaker-diarization-community-1") ;;
    --all-models)
      MODEL_IDS+=("pyannote/speaker-diarization-3.1")
      MODEL_IDS+=("pyannote/speaker-diarization-community-1")
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── 1. Check Python 3 ─────────────────────────────────────────────────────────

PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" &>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "Error: Python 3.10+ is required. Install via:"
  echo "  brew install python@3.12"
  exit 1
fi

PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON" -c "import sys; print(sys.version_info.minor)")

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  echo "Error: Python 3.10+ required (found $PY_VERSION)"
  exit 1
fi

echo "Using Python $PY_VERSION ($PYTHON)"

# ── 2. Create virtual environment ─────────────────────────────────────────────

if [ -d "$VENV_DIR" ]; then
  echo "Virtual environment already exists: $VENV_DIR"
else
  echo "Creating virtual environment..."
  "$PYTHON" -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

# ── 3. Install dependencies ───────────────────────────────────────────────────

echo "Installing dependencies (this may take a few minutes)..."
pip install --upgrade pip --quiet
pip install -r "$REQUIREMENTS" --quiet

echo "Dependencies installed."

# ── 4. Verify installation ────────────────────────────────────────────────────

python3 -c "import pyannote.audio; print(f'pyannote.audio {pyannote.audio.__version__}')"
python3 -c "import torch; print(f'PyTorch {torch.__version__} (MPS: {torch.backends.mps.is_available()})')"

# ── 5. Download models (optional) ─────────────────────────────────────────────

if [ ${#MODEL_IDS[@]} -gt 0 ]; then
  mkdir -p "$MODEL_DIR"
  for MODEL_ID in "${MODEL_IDS[@]}"; do
    echo ""
    echo "Downloading $MODEL_ID ..."
    echo "(Requires a HuggingFace token + accepted terms at https://huggingface.co/$MODEL_ID)"
    python3 -c "
from pyannote.audio import Pipeline
model_dir = '$MODEL_DIR'
model_id = '$MODEL_ID'
print(f'  cache_dir: {model_dir}')

try:
    pipeline = Pipeline.from_pretrained(model_id, cache_dir=model_dir)
    print(f'  {model_id} downloaded.')
except Exception as e:
    print(f'  Error: {e}')
    print('  Note: gated model. Requires:')
    print(f'    - https://huggingface.co/{model_id} (accept terms)')
    print('    - huggingface-cli login (set token)')
    exit(1)
"
  done
fi

deactivate

echo ""
echo "=== Setup complete ==="
echo ""
echo "Virtual environment: $VENV_DIR"
echo "Python: $VENV_DIR/bin/python3"
echo ""
if [ ${#MODEL_IDS[@]} -eq 0 ]; then
  echo "To download diarization models, run one of:"
  echo "  ./scripts/setup-pyannote.sh --model             (downloads 3.1)"
  echo "  ./scripts/setup-pyannote.sh --model-community   (downloads community-1)"
  echo "  ./scripts/setup-pyannote.sh --all-models        (downloads both)"
fi
