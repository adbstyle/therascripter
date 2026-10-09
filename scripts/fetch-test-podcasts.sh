#!/usr/bin/env bash
# Lädt drei SRF-«Input»-Folgen als realistische Test-Audios (Schweizer Hochdeutsch,
# mehrere Sprecher, 28–45 min) nach tests/fixtures/podcast-audio/.
# Gitignored: urheberrechtlich geschützt (SRF) und ~100 MB — nie committen.
set -euo pipefail
DEST="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/podcast-audio"
mkdir -p "$DEST"
BASE="https://download-media.srf.ch/world/audio/Input_radio/2026/09"
while read -r name file; do
  [ -f "$DEST/$name" ] && { echo "✓ $name (vorhanden)"; continue; }
  echo "↓ $name"
  curl -fL --progress-bar -o "$DEST/$name.part" "$BASE/$file" && mv "$DEST/$name.part" "$DEST/$name"
done <<LIST
2026-09-30_notloesung-kinderzimmer.mp3 Input_radio_AUDI20260930_NR_0023_2a2adf273d534dd5a460f43eee0ce09d.mp3
2026-09-23_zwei-frauen-rollenbild.mp3 Input_radio_AUDI20260923_NR_0022_b2e7edda23fd4df5b2b64f3dfa150320.mp3
2026-09-16_eizellen-einfrieren.mp3 Input_radio_AUDI20260916_NR_0019_8bb1184a0e8544d79e069f85ae7a7980.mp3
LIST
