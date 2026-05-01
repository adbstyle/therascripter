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

# ARM64 static build from osxexperts.net (Apple Silicon native).
# evermeet.cx only ships x86_64 — using that on ARM64 requires Rosetta 2 and
# kills the performance benefits of running on Apple Silicon, so we use the
# osxexperts arm64 build instead. Verified: file says "Mach-O 64-bit
# executable arm64", otool -L shows only system frameworks.
# Refresh URL when bumping ffmpeg version (browse https://www.osxexperts.net/).
FFMPEG_URL="https://www.osxexperts.net/ffmpeg7arm.zip"
ZIP_PATH="$TMP_DIR/ffmpeg.zip"

echo "Downloading static arm64 ffmpeg from $FFMPEG_URL..."
curl -fL --retry 3 -o "$ZIP_PATH" "$FFMPEG_URL"

unzip -q "$ZIP_PATH" -d "$TMP_DIR"
mv "$TMP_DIR/ffmpeg" "$DEST"
chmod +x "$DEST"

# Ad-hoc codesign so the bundled binary launches under app sandbox
# (analogous to whisper-cli / llama-cli setup).
codesign --sign - --force "$DEST"

# Sanity: refuse to install a non-arm64 binary. The whole reason this script
# exists is Apple Silicon support — bundling x86_64 silently would force
# users onto Rosetta 2 and waste the performance benefit of the inversion.
if ! file "$DEST" | grep -q "arm64"; then
  echo "ERROR: installed ffmpeg is not arm64. file output:" >&2
  file "$DEST" >&2
  rm -f "$DEST"
  exit 1
fi

# Sanity: verify it's truly static (only system libs)
echo "Linked libraries (should only show /usr/lib/* system libs):"
otool -L "$DEST" | tail -n +2

echo
echo "ffmpeg installed at $DEST"
file "$DEST"
"$DEST" -version | head -1
