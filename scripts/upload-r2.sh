#!/usr/bin/env bash
# Upload packaged archives to Cloudflare R2 via S3 compatibility API.
# Uses AWS CLI with multipart upload — no 300 MB file size limit.
# Credentials: Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env
# Requires: brew install awscli
# Usage: scripts/upload-r2.sh [source-dir]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="${1:-$PROJECT_ROOT/r2-upload}"
BUCKET="therascript"

# Load .env if present
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Validate credentials
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "Error: R2-Credentials fehlen."
  echo ""
  echo "Benötigt in .env:"
  echo "  CLOUDFLARE_ACCOUNT_ID=..."
  echo "  R2_ACCESS_KEY_ID=..."
  echo "  R2_SECRET_ACCESS_KEY=..."
  echo ""
  echo "Setup: cp .env.example .env && # Werte eintragen"
  echo "R2 API Token erstellen: Cloudflare Dashboard → R2 → Manage R2 API Tokens"
  exit 1
fi

# Check AWS CLI
if ! command -v aws &>/dev/null; then
  echo "Error: AWS CLI nicht gefunden."
  echo "Installieren: brew install awscli"
  exit 1
fi

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Error: Source directory not found: $SOURCE_DIR"
  echo "Run scripts/package-models.sh first."
  exit 1
fi

FILES=$(ls "$SOURCE_DIR" 2>/dev/null)
if [ -z "$FILES" ]; then
  echo "Error: No files found in $SOURCE_DIR"
  exit 1
fi

R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Export as AWS env vars (no profile needed)
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

echo "=== Uploading to R2 bucket: $BUCKET ==="
echo "Endpoint: $R2_ENDPOINT"
echo "Source: $SOURCE_DIR"
echo ""

for f in "$SOURCE_DIR"/*; do
  [ -f "$f" ] || continue
  NAME=$(basename "$f")
  SIZE=$(du -h "$f" | cut -f1)
  echo "Uploading $NAME ($SIZE)..."
  aws s3 cp "$f" "s3://$BUCKET/$NAME" \
    --endpoint-url "$R2_ENDPOINT" \
    --no-progress
  echo "  -> OK"
done

echo ""
echo "=== Verifying ==="
aws s3 ls "s3://$BUCKET/" \
  --endpoint-url "$R2_ENDPOINT"

echo ""
echo "=== Done ==="
echo "Files are available at: https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev/"
echo ""
echo "Next: Update sha256 and sizeBytes in src/main/services/ModelDownloadService.ts"
echo "Hint: Run scripts/package-models.sh to see hashes."
