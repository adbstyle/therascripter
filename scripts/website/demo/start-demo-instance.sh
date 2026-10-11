#!/usr/bin/env bash
# Startet eine eigene TheraScript-Instanz für die Demo-Sitzung (Epic #172), getrennt
# von den echten Daten: eigener Daten-Ordner (statt ~/.therascript) und eigener
# Settings-Ordner, CDP auf Port 9224. Läuft aus dem gebauten Stand dieses Checkouts
# (npm run build), mit dessen resources/ und python_sidecar/.
#
# Usage: scripts/website/demo/start-demo-instance.sh <sandbox-dir> [--fake-mic <wav>]
#
# - Beim ersten Aufruf werden die Modelle aus ~/.therascript/models per APFS-Klon
#   (cp -c, kein zusätzlicher Platz) in die Sandbox kopiert.
# - --fake-mic ersetzt das Mikrofon durch eine WAV-Datei (Chromium-Fake-Device,
#   einmal abgespielt) — für die Aufnahme-Animation.
#
# Warum nicht einfach HOME umbiegen: Electron löst app.getPath('home') auf macOS
# nicht über $HOME auf, die gepackte App schrieb so in die echten Daten. Der Wrapper
# setzt die Pfade deshalb per app.setPath, bevor der Main-Prozess startet.
set -euo pipefail
SB="${1:?Usage: start-demo-instance.sh <sandbox-dir> [--fake-mic <wav>]}"
shift
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EXTRA=()
if [ "${1:-}" = "--fake-mic" ]; then
  EXTRA=(--use-fake-ui-for-media-stream --use-fake-device-for-media-stream "--use-file-for-fake-audio-capture=${2:?wav fehlt}%noloop")
fi

[ -f "$ROOT/out/main/index.js" ] || { echo "Zuerst npm run build"; exit 1; }
mkdir -p "$SB/home/.therascript" "$SB/userData" "$SB/app"
if [ ! -d "$SB/home/.therascript/models" ]; then
  cp -c -R "$HOME/.therascript/models" "$SB/home/.therascript/models"
fi
ln -sfn "$ROOT/resources" "$SB/app/resources"
ln -sfn "$ROOT/python_sidecar" "$SB/app/python_sidecar"
node -e '
  const p = require(process.argv[1] + "/package.json")
  require("fs").writeFileSync(process.argv[2] + "/package.json",
    JSON.stringify({ name: p.name, productName: p.productName, version: p.version, main: "main.cjs" }))
' "$ROOT" "$SB/app"
cat > "$SB/app/main.cjs" <<EOF
// Demo-Instanz: Daten- und Settings-Pfade in die Sandbox, dann der echte Main-Prozess.
const { app } = require('electron')
app.setPath('home', '$SB/home')
app.setPath('userData', '$SB/userData')
require('$ROOT/out/main/index.js')
EOF

# Startzustand: Modelle als installiert, Zusammenfassung aktiv, Einwilligungshinweis an.
if [ ! -f "$SB/userData/settings.json" ]; then
  cat > "$SB/userData/settings.json" <<'EOF'
{
  "activeModels": {
    "transcription": "whisper-large-v3-turbo-german",
    "diarization": "pyannote-suite",
    "diarizationPipeline": "pyannote/speaker-diarization-3.1",
    "ner": "flair-ner-german-large",
    "ocr": "apple-vision",
    "summarization": "gemma-4-e2b-summarization"
  },
  "firstLaunchDone": true,
  "modelsDownloaded": true,
  "consentReminderShown": false,
  "backgroundReminderShown": true,
  "theme": "light",
  "reviewPanelOpen": true
}
EOF
fi

# Minimal-Env wie beim Start aus dem Finder (keine Homebrew-/HF-Variablen der Shell).
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  TMPDIR="$TMPDIR" LANG=de_CH.UTF-8 \
  "$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$SB/app" \
  --remote-debugging-port=9224 ${EXTRA[@]+"${EXTRA[@]}"} > "$SB/app.log" 2>&1 &
echo "Demo-Instanz gestartet (PID $!), Log: $SB/app.log, CDP-Port 9224"
