#!/usr/bin/env bash
set -euo pipefail

# Installs static ARM64 ffmpeg binary for the Therascript app bundle.
# Uses evermeet.cx static builds — single self-contained binary, no dylib deps.

DEST_DIR="$(cd "$(dirname "$0")/../resources/bin" && pwd)"
DEST="$DEST_DIR/ffmpeg"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [[ -f "$DEST" ]]; then
  echo "ffmpeg already present at $DEST"
  "$DEST" -version | head -1
  exit 0
fi

# Pin to a known-good ARM64 build.
# Update URL when bumping ffmpeg version. Latest stable list: https://evermeet.cx/ffmpeg/
FFMPEG_URL="https://evermeet.cx/ffmpeg/ffmpeg-7.1.zip"
ZIP_PATH="$TMP_DIR/ffmpeg.zip"

echo "Downloading static ffmpeg from $FFMPEG_URL..."
curl -fL --retry 3 -o "$ZIP_PATH" "$FFMPEG_URL"

unzip -q "$ZIP_PATH" -d "$TMP_DIR"
mv "$TMP_DIR/ffmpeg" "$DEST"
chmod +x "$DEST"

# Ad-hoc codesign so the bundled binary launches under app sandbox
# (analogous to whisper-cli / llama-cli setup).
codesign --sign - --force "$DEST"

# Sanity: verify it's truly static (only system libs)
echo "Linked libraries (should only show /usr/lib/* system libs):"
otool -L "$DEST" | tail -n +2

echo
echo "ffmpeg installed at $DEST"
"$DEST" -version | head -1
