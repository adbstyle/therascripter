#!/usr/bin/env bash
# Macht aus den Aufnahmen von capture.mjs die Bilddateien der Landing Page:
#   <name>-<theme>.png          → website/assets/<name>-<theme>.webp (Standbild)
#   <name>-<theme>/ (Einzelbilder + timeline.json)
#                               → website/assets/<name>-<theme>.gif (läuft einmal, kein Loop)
#                               → website/assets/<name>-<theme>-ende.webp (Endzustand für
#                                 prefers-reduced-motion)
# Usage: scripts/website/build-gifs.sh <capture-out-dir>
# Braucht ffmpeg und cwebp (Homebrew: ffmpeg, webp).
set -euo pipefail
IN="${1:?Usage: build-gifs.sh <capture-out-dir>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/website/assets"
STILL_WIDTH=1600
GIF_WIDTH=880
GIF_FPS=12

for png in "$IN"/*.png; do
  [ -e "$png" ] || continue
  name=$(basename "$png" .png)
  cwebp -quiet -q 82 -m 6 -resize "$STILL_WIDTH" 0 "$png" -o "$OUT/$name.webp"
  echo "$name.webp $(du -k "$OUT/$name.webp" | cut -f1) KB"
done

for dir in "$IN"/*/; do
  [ -f "$dir/timeline.json" ] || continue
  name=$(basename "$dir")
  list="$dir/concat.txt"
  node -e '
    const t = require(process.argv[1] + "/timeline.json")
    const lines = t.flatMap((f) => [`file ${f.file}`, `duration ${f.duration}`])
    lines.push(`file ${t[t.length - 1].file}`)
    require("fs").writeFileSync(process.argv[1] + "/concat.txt", lines.join("\n") + "\n")
  ' "$dir"
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$list" \
    -vf "fps=$GIF_FPS,scale=$GIF_WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop -1 "$OUT/$name.gif"
  last=$(node -e 'const t=require(process.argv[1]+"/timeline.json");console.log(t[t.length-1].file)' "$dir")
  cwebp -quiet -q 82 -m 6 -resize "$STILL_WIDTH" 0 "$dir/$last" -o "$OUT/$name-ende.webp"
  echo "$name.gif $(du -k "$OUT/$name.gif" | cut -f1) KB, $name-ende.webp $(du -k "$OUT/$name-ende.webp" | cut -f1) KB"
done
