#!/usr/bin/env bash
# Macht aus den Aufnahmen von capture.mjs die Bilddateien der Landing Page:
#   <name>-<theme>.png          → website/assets/<name>-<theme>.webp (Standbild)
#   <name>-<theme>/ (Einzelbilder + timeline.json)
#                               → website/assets/<name>-<theme>.gif (Endlosschleife, Endzustand
#                                 bleibt END_PAUSE Sekunden stehen)
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
# Ein GIF startet beim Laden, und lazy lädt der Browser schon deutlich vor dem
# sichtbaren Bereich. Einmal abgespielt sähen Besucher:innen oft nur das Ende; deshalb
# Schleife mit langer Pause auf dem Endzustand.
END_PAUSE=5

for png in "$IN"/*.png; do
  [ -e "$png" ] || continue
  name=$(basename "$png" .png)
  cwebp -quiet -q 82 -m 6 -resize "$STILL_WIDTH" 0 "$png" -o "$OUT/$name.webp"
  echo "$name.webp $(du -k "$OUT/$name.webp" | cut -f1) KB"
done

for dir in "$IN"/*/; do
  [ -f "$dir/timeline.json" ] || continue
  name=$(basename "$dir")
  # Bildfolge im festen GIF-Raster (1/GIF_FPS s) selbst berechnen: Der Concat-Demuxer von
  # ffmpeg verschätzt sich bei Bildern von wenigen Millisekunden und beim letzten Bild um
  # Sekunden. Jeder Rasterpunkt zeigt das zuletzt aufgenommene Bild (Symlinks in seq/).
  rm -rf "$dir/seq" && mkdir "$dir/seq"
  node -e '
    const fs = require("fs")
    const [dir, pause, fps] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])]
    const t = require(dir + "/timeline.json")
    t[t.length - 1].duration = pause
    let n = 0
    let carry = 0
    for (const f of t) {
      carry += f.duration
      for (; carry >= 1 / fps; carry -= 1 / fps) {
        fs.symlinkSync("../" + f.file, `${dir}/seq/${String(n++).padStart(5, "0")}.${f.file.split(".").pop()}`)
      }
    }
  ' "$dir" "$END_PAUSE" "$GIF_FPS"
  ext=$(ls "$dir/seq" | head -1 | sed 's/.*\.//')
  ffmpeg -loglevel error -y -framerate "$GIF_FPS" -i "$dir/seq/%05d.$ext" \
    -vf "scale=$GIF_WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
    -loop 0 "$OUT/$name.gif"
  last=$(node -e 'const t=require(process.argv[1]+"/timeline.json");console.log(t[t.length-1].file)' "$dir")
  cwebp -quiet -q 82 -m 6 -resize "$STILL_WIDTH" 0 "$dir/$last" -o "$OUT/$name-ende.webp"
  echo "$name.gif $(du -k "$OUT/$name.gif" | cut -f1) KB, $name-ende.webp $(du -k "$OUT/$name-ende.webp" | cut -f1) KB"
done
