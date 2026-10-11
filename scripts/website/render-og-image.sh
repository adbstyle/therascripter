#!/usr/bin/env bash
# Rendert scripts/website/og-image.html zu website/assets/og-image.png (1200×630)
# mit Google Chrome headless. Nach einer Änderung den Cache-Buster ?v=N am
# og:image in website/index.html erhöhen, sonst zeigen Messenger das alte Bild.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/website/assets/og-image.png"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --screenshot="$OUT" "file://$ROOT/scripts/website/og-image.html" 2>/dev/null
sips -g pixelWidth -g pixelHeight "$OUT" | tail -2
