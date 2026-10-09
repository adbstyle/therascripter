#!/usr/bin/env bash
# Lädt drei SRF-«Input»-Folgen als realistische Test-Audios (Schweizer Hochdeutsch,
# mehrere Sprecher, 28–45 min) nach tests/fixtures/podcast-audio/ und legt neben
# jedes MP3 eine WAV im Aufnahmeformat der App (48 kHz, mono, 16-bit PCM).
# Gitignored: urheberrechtlich geschützt (SRF), MP3 + WAV ~680 MB — nie committen.
#
# Warum die WAV einen kanonischen 44-Byte-Header braucht: AudioStitchService
# rechnet Byte-Offsets fix als 44 + Sample · 2. afconvert schreibt vor den
# data-Chunk einen FLLR-Füllchunk (data liegt dann bei 4096) — die Stitch-Ranges
# wären verschoben und der Header würde als Audio mitgestitcht. Deshalb wird die
# afconvert-Ausgabe über Pythons wave-Modul neu geschrieben.
#
# Exit-Code ≠ 0, sobald eine Folge fehlt, nicht verifiziert oder nicht
# konvertiert werden konnte (z. B. von SRF depubliziert).
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/podcast-audio"
BASE="https://download-media.srf.ch/world/audio/Input_radio/2026/09"
mkdir -p "$DEST"

sha_ok() {
  [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]
}

# Funktionen, die in einer ||-Liste aufgerufen werden, laufen OHNE errexit —
# deshalb trägt jeder Schritt sein eigenes `|| return 1`.
to_app_wav() {
  local src="$1" out="$2" tmp="$2.afconvert.wav"
  afconvert -f WAVE -d LEI16@48000 -c 1 "$src" "$tmp" || { rm -f "$tmp"; return 1; }
  python3 -I - "$tmp" "$out.part" <<'PY' || { rm -f "$tmp" "$out.part"; return 1; }
import os
import sys
import wave

src, dst = sys.argv[1], sys.argv[2]
with wave.open(src, "rb") as r:
    assert (r.getnchannels(), r.getsampwidth(), r.getframerate()) == (1, 2, 48000)
    nframes = r.getnframes()
    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        while frames := r.readframes(1 << 20):
            w.writeframes(frames)
assert os.path.getsize(dst) == 44 + nframes * 2, "WAV-Header ist nicht 44 Byte"
PY
  rm -f "$tmp"
  mv "$out.part" "$out"
}

fetch() {
  local name="$1" file="$2" sha="$3"
  local mp3="$DEST/$name.mp3" wav="$DEST/$name.wav"

  if [ -f "$mp3" ] && sha_ok "$mp3" "$sha"; then
    echo "✓ $name.mp3 (vorhanden, Hash ok)"
  else
    echo "↓ $name.mp3"
    rm -f "$mp3" "$wav"
    # -C - setzt einen abgebrochenen Download fort; --retry fängt kurze Netzaussetzer ab.
    curl -fL --retry 3 --retry-delay 2 -C - --progress-bar -o "$mp3.part" "$BASE/$file" ||
      { echo "✗ $name: Download fehlgeschlagen ($BASE/$file)" >&2; return 1; }
    if ! sha_ok "$mp3.part" "$sha"; then
      rm -f "$mp3.part"
      echo "✗ $name: SHA-256 stimmt nicht — Datei bei SRF geändert oder Download defekt" >&2
      return 1
    fi
    mv "$mp3.part" "$mp3"
  fi

  if [ -f "$wav" ]; then
    echo "✓ $name.wav (vorhanden)"
  else
    echo "→ $name.wav (48 kHz mono 16-bit)"
    to_app_wav "$mp3" "$wav" || { echo "✗ $name: WAV-Konvertierung fehlgeschlagen" >&2; return 1; }
  fi
}

# Liste über fd 3, damit kein Subprozess in fetch() versehentlich von ihr liest.
failed=0
while read -r name file sha <&3; do
  fetch "$name" "$file" "$sha" || failed=1
done 3<<'LIST'
2026-09-30_notloesung-kinderzimmer Input_radio_AUDI20260930_NR_0023_2a2adf273d534dd5a460f43eee0ce09d.mp3 46811eadd3cfe033927ebf85643b2758571297748d9e9812270d06473e9c63ca
2026-09-23_zwei-frauen-rollenbild Input_radio_AUDI20260923_NR_0022_b2e7edda23fd4df5b2b64f3dfa150320.mp3 5314bbbbefb1d687ed67d6720d468b19ce4e4229caf10461a6be2fddd00c18c1
2026-09-16_eizellen-einfrieren Input_radio_AUDI20260916_NR_0019_8bb1184a0e8544d79e069f85ae7a7980.mp3 fdce564c1c54288bcc3a7b601dcfa95d3e6152d9e91b16a84311c689cc09ea9d
LIST

exit "$failed"
