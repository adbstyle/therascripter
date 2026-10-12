#!/usr/bin/env bash
# Veröffentlicht die signierte Update-Beschreibung (manifest.json) auf R2.
#
# Usage: scripts/publish-manifest.sh --from-catalog [--dmg <Therascript.dmg>] [--dry-run]
#
#   --from-catalog  Modell-Einträge aus src/shared/model-catalog.ts (URL, sha256,
#                   Grösse), jedes Artefakt per HEAD gegen R2 geprüft
#                   (scripts/manifest-from-catalog.ts). Der einzige Weg — frühere
#                   Modi (aus r2-upload/, --app-version-only) sind entfallen: jedes
#                   Manifest muss signiert sein, und der Katalog ist die Quelle.
#   --dmg <pfad>    Installationspaket dieses Releases: Version, URL, Grösse und
#                   sha256 kommen in den App-Eintrag (release.sh übergibt es).
#                   Ohne --dmg bleibt der App-Eintrag des Live-Manifests, falls er
#                   schon diese Version beschreibt (Modell-Update zwischen Releases).
#   --dry-run       Nur erzeugen und signieren, nichts hochladen.
#
# Signatur (Issue #163): Ed25519 über die exakten Bytes von manifest.json,
# Hauptschlüssel aus dem Schlüsselbund (scripts/lib/signing-keychain.ts), nach
# dessen Verlust der Reserveschlüssel über THERASCRIPT_SIGNING_KEY_FILE. Die
# Signatur liegt unter signatures/<sha256 des Manifests>.json und wird VOR dem
# Manifest hochgeladen — eine App findet zu jedem Manifest, das sie sieht, die
# passende Signatur. Danach prüft das Skript beide über die öffentliche URL.
# Jeder Fehler endet mit Exit ≠ 0 und Grund (PC 1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
MANIFEST_FILE="$PROJECT_ROOT/manifest.json"
BUCKET="therascript"
CDN_BASE=$(sed -n "s/^export const R2_CDN = '\(.*\)'/\1/p" "$PROJECT_ROOT/src/shared/model-catalog.ts")

FROM_CATALOG=false
DRY_RUN=false
DMG_PATH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-catalog) FROM_CATALOG=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --dmg)
      [ $# -ge 2 ] || { echo "❌ --dmg braucht einen Pfad"; exit 1; }
      DMG_PATH="$2"; shift 2 ;;
    *) echo "❌ Unbekannte Option: $1"; exit 1 ;;
  esac
done
if [ "$FROM_CATALOG" != true ]; then
  echo "❌ Nur noch --from-catalog wird unterstützt (signiertes Manifest aus dem Katalog)."
  echo "   Usage: scripts/publish-manifest.sh --from-catalog [--dmg <Therascript.dmg>] [--dry-run]"
  exit 1
fi
if [ -n "$DMG_PATH" ] && [ ! -f "$DMG_PATH" ]; then
  echo "❌ DMG nicht gefunden: $DMG_PATH"
  exit 1
fi
if [ -z "$CDN_BASE" ]; then
  echo "❌ R2_CDN nicht in src/shared/model-catalog.ts gefunden"
  exit 1
fi

ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

APP_VERSION=$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)")
echo "=== Manifest aus Katalog (latestAppVersion=$APP_VERSION) ==="
DMG_ARGS=()
[ -n "$DMG_PATH" ] && DMG_ARGS=(--dmg "$DMG_PATH")
# Erst in eine Temp-Datei: bricht die R2-Prüfung ab, bleibt manifest.json unberührt.
(cd "$PROJECT_ROOT" && npx tsx "$SCRIPT_DIR/manifest-from-catalog.ts" "$APP_VERSION" ${DMG_ARGS[@]+"${DMG_ARGS[@]}"}) > "$MANIFEST_FILE.tmp"
mv "$MANIFEST_FILE.tmp" "$MANIFEST_FILE"
echo "  -> $MANIFEST_FILE"

echo "=== Signieren ==="
SIG_PATH=$(cd "$PROJECT_ROOT" && npx tsx "$SCRIPT_DIR/sign-manifest.ts" "$MANIFEST_FILE")
echo "  -> $MANIFEST_FILE.sig ($SIG_PATH)"

if [ "$DRY_RUN" = true ]; then
  echo "(Dry-run: kein Upload)"
  cat "$MANIFEST_FILE"
  exit 0
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "❌ R2-Credentials fehlen. CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env setzen"
  exit 1
fi
if ! command -v aws &>/dev/null; then
  echo "❌ AWS CLI nicht gefunden. Installieren: brew install awscli"
  exit 1
fi
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="auto"
R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo "=== Hochladen (Signatur zuerst) ==="
aws s3 cp "$MANIFEST_FILE.sig" "s3://$BUCKET/$SIG_PATH" \
  --endpoint-url "$R2_ENDPOINT" --content-type "application/json" --no-progress
aws s3 cp "$MANIFEST_FILE" "s3://$BUCKET/manifest.json" \
  --endpoint-url "$R2_ENDPOINT" --content-type "application/json" --no-progress

echo "=== Öffentlich abrufbar? ==="
LOCAL_SHA=$(shasum -a 256 "$MANIFEST_FILE" | cut -d' ' -f1)
REMOTE_SHA=$(curl -fsS -H 'Cache-Control: no-cache' "$CDN_BASE/manifest.json" | shasum -a 256 | cut -d' ' -f1)
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "❌ $CDN_BASE/manifest.json liefert nicht das eben hochgeladene Manifest"
  exit 1
fi
if ! curl -fsS "$CDN_BASE/$SIG_PATH" | cmp -s - "$MANIFEST_FILE.sig"; then
  echo "❌ Signatur unter $CDN_BASE/$SIG_PATH nicht abrufbar oder abweichend"
  exit 1
fi
echo "  -> OK: manifest.json und $SIG_PATH öffentlich abrufbar"
