#!/usr/bin/env bash
# Generate manifest.json from packaged model archives in r2-upload/ and upload to R2.
# Run AFTER scripts/package-models.sh has populated r2-upload/ with the model files.
# Usage: scripts/publish-manifest.sh [--dry-run | --app-version-only]
#   --app-version-only  Download existing manifest from R2, patch latestAppVersion, re-upload.
#                       Does NOT require model files in r2-upload/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="$PROJECT_ROOT/r2-upload"
MANIFEST_FILE="$PROJECT_ROOT/manifest.json"
BUCKET="therascript"
MODE="${1:-}"

# Load .env if present
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# ── App-version-only mode ────────────────────────────────────────────────────
# Downloads existing manifest from R2, patches latestAppVersion, re-uploads.
if [ "$MODE" = "--app-version-only" ]; then
  APP_VERSION=$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)")

  # Validate R2 credentials
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
    echo "Error: R2-Credentials fehlen. CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env setzen"
    exit 1
  fi
  if ! command -v aws &>/dev/null; then
    echo "Error: AWS CLI nicht gefunden. Installieren: brew install awscli"
    exit 1
  fi

  R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION="auto"

  echo "=== App-Version-Only Mode ==="
  echo "  Downloading existing manifest.json from R2 …"
  aws s3 cp "s3://$BUCKET/manifest.json" "$MANIFEST_FILE" \
    --endpoint-url "$R2_ENDPOINT" --no-progress

  echo "  Patching latestAppVersion → $APP_VERSION …"
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('$MANIFEST_FILE', 'utf8'));
    m.latestAppVersion = '$APP_VERSION';
    m.generatedAt = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');
    fs.writeFileSync('$MANIFEST_FILE', JSON.stringify(m, null, 2) + '\n');
  "

  echo "  Uploading patched manifest.json to R2 …"
  aws s3 cp "$MANIFEST_FILE" "s3://$BUCKET/manifest.json" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/json" \
    --no-progress

  echo "  -> OK (latestAppVersion=$APP_VERSION)"
  exit 0
fi

# ── Full mode (models + app version) ────────────────────────────────────────

# Model metadata: id|filename|label|relativePath|archive|checkPath
# Must match MODEL_DEFINITIONS in ModelDownloadService.ts
declare -a MODELS=(
  "whisper-large-v3-turbo|whisper-ggml-large-v3-turbo-q5_0.bin|Spracherkennung (whisper-large-v3-turbo)|asr/ggml-large-v3-turbo-q5_0.bin|false|asr/ggml-large-v3-turbo-q5_0.bin"
  "pyannote-community-1|pyannote-models.tar.gz|Sprechererkennung (pyannote-community-1)|diarization|true|diarization/models--pyannote--speaker-diarization-3.1"
  "flair-ner-german-large|flair-ner-german-large.tar.gz|Anonymisierung (flair-ner-german-large)|ner|true|ner/models/ner-german-large"
)

# CDN base URL
CDN_BASE="https://pub-f6971d643e3a464ba6977c0816c43e50.r2.dev"

# Today's date as version string
VERSION=$(date +%Y-%m-%d)
GENERATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
APP_VERSION=$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)")

echo "=== Generating manifest.json ==="
echo "Version: $VERSION"
echo "Source: $SOURCE_DIR"
echo ""

# Validate source files exist
for MODEL_ENTRY in "${MODELS[@]}"; do
  IFS='|' read -r ID FILENAME LABEL _ <<< "$MODEL_ENTRY"
  FILE="$SOURCE_DIR/$FILENAME"
  if [ ! -f "$FILE" ]; then
    echo "Error: Modelldatei nicht gefunden: $FILE"
    echo "Zuerst ausführen: npm run sidecar:package"
    exit 1
  fi
done

# Build JSON
MODELS_JSON="["
FIRST=true
for MODEL_ENTRY in "${MODELS[@]}"; do
  IFS='|' read -r ID FILENAME LABEL RELATIVE_PATH ARCHIVE CHECK_PATH <<< "$MODEL_ENTRY"
  FILE="$SOURCE_DIR/$FILENAME"

  HASH=$(shasum -a 256 "$FILE" | cut -d' ' -f1)
  SIZE=$(stat -f%z "$FILE")
  URL="$CDN_BASE/$FILENAME"

  echo "  $ID"
  echo "    sha256:    $HASH"
  echo "    sizeBytes: $SIZE"
  echo "    url:       $URL"
  echo ""

  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    MODELS_JSON="$MODELS_JSON,"
  fi

  MODELS_JSON="$MODELS_JSON
    {
      \"id\": \"$ID\",
      \"version\": \"$VERSION\",
      \"label\": \"$LABEL\",
      \"url\": \"$URL\",
      \"sha256\": \"$HASH\",
      \"sizeBytes\": $SIZE
    }"
done
MODELS_JSON="$MODELS_JSON
  ]"

# Write manifest.json
cat > "$MANIFEST_FILE" << EOF
{
  "generatedAt": "$GENERATED_AT",
  "latestAppVersion": "$APP_VERSION",
  "models": $MODELS_JSON
}
EOF

echo "=== manifest.json geschrieben: $MANIFEST_FILE ==="
echo ""

if [ "$MODE" = "--dry-run" ]; then
  echo "(Dry-run: kein Upload)"
  cat "$MANIFEST_FILE"
  exit 0
fi

# Validate R2 credentials
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "Warnung: R2-Credentials fehlen — manifest.json wurde lokal geschrieben, aber nicht hochgeladen."
  echo "Zum Hochladen: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env setzen"
  exit 0
fi

if ! command -v aws &>/dev/null; then
  echo "Error: AWS CLI nicht gefunden. Installieren: brew install awscli"
  exit 1
fi

R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"

echo "=== Uploading manifest.json to R2 ==="
aws s3 cp "$MANIFEST_FILE" "s3://$BUCKET/manifest.json" \
  --endpoint-url "$R2_ENDPOINT" \
  --content-type "application/json" \
  --no-progress

echo "  -> OK"
echo ""
echo "manifest.json verfügbar unter: $CDN_BASE/manifest.json"
echo ""
echo "Nächste Schritte:"
echo "  1. npm run build           # TypeScript prüfen"
echo "  2. git add manifest.json && git commit -m 'chore: update model manifest $VERSION'"
