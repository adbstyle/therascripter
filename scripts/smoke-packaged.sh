#!/usr/bin/env bash
#
# Runtime-Smoke-Tests der gebundelten ML-Tools in einer Homebrew-freien Sandbox.
#
# Warum: Statische Checks (verify-bundles.sh) können den ggml-Plugin-dlopen
# nicht prüfen — der hardcodete Fallback /opt/homebrew/Cellar/ggml/<ver>/libexec
# maskiert auf Dev-Macs JEDEN Layout-Fehler (Regression 77a1b7c: Summarization
# war auf Endnutzer-Macs tot, auf Dev-Macs grün). Dieses Script führt jedes
# Tool tatsächlich AUS, während sandbox-exec /opt/homebrew und die maskierenden
# HF-/flair-Caches wegblendet — wie auf einem Mac, der nur das DMG hat.
#
# Usage:
#   ./scripts/smoke-packaged.sh                    # /Applications/Therascript.app
#   ./scripts/smoke-packaged.sh --app <pfad>       # bestimmte .app
#   ./scripts/smoke-packaged.sh --dist             # dist/mac-arm64/Therascript.app
#   ./scripts/smoke-packaged.sh --staging          # Repo-Staging-Tree (resources/,
#                                                  #   python_sidecar/standalone/)
#
# Exit: 0 wenn alle Checks grün, 1 sonst.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="/Applications/Therascript.app"
MODE="app"
while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      if [ $# -lt 2 ]; then echo "FEHLER: --app braucht einen Pfad" >&2; exit 2; fi
      TARGET="$2"; MODE="app"; shift 2 ;;
    --dist) TARGET="$REPO_ROOT/dist/mac-arm64/Therascript.app"; MODE="app"; shift ;;
    --staging) MODE="staging"; shift ;;
    *) echo "FEHLER: unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

# Gate-Modus (app/dist): Skips gelten als FEHLER. Ein Smoke-Lauf gegen eine
# gepackte .app, in dem die kritischen Checks (llama CPU-buft, NER offline,
# Diarization offline)
# mangels Modellen oder Binaries gar nicht laufen, darf NICHT grün enden —
# sonst released release.sh ein ungetestetes DMG mit "SMOKE OK". Nur --staging
# bleibt tolerant (halbfertige Dev-Checkouts).
STRICT=false
if [ "$MODE" = "app" ]; then
  STRICT=true
  RES="$TARGET/Contents/Resources"
  if [ ! -d "$RES" ]; then
    echo "FEHLER: $TARGET ist keine .app (Contents/Resources fehlt)" >&2
    exit 2
  fi
  WHISPER_CLI="$RES/whisper/bin/whisper-cli"
  LLAMA_CLI="$RES/llama/bin/llama-cli"
  SIDECAR_PY="$RES/ml_sidecar/standalone/bin/python3"
  NER_SCRIPT="$RES/ml_sidecar/ner_service.py"
  DIARIZE_SCRIPT="$RES/ml_sidecar/diarize.py"
  VISION_OCR="$RES/bin/vision-ocr"
  echo "Smoke-Target: $TARGET"
else
  WHISPER_CLI="$REPO_ROOT/resources/whisper/bin/whisper-cli"
  LLAMA_CLI="$REPO_ROOT/resources/llama/bin/llama-cli"
  SIDECAR_PY="$REPO_ROOT/python_sidecar/standalone/bin/python3"
  NER_SCRIPT="$REPO_ROOT/python_sidecar/ner_service.py"
  DIARIZE_SCRIPT="$REPO_ROOT/python_sidecar/diarize.py"
  VISION_OCR="$REPO_ROOT/resources/bin/vision-ocr"
  echo "Smoke-Target: Repo-Staging-Tree ($REPO_ROOT)"
fi

# ── Sandbox-Profil: Homebrew + maskierende Caches wegblenden ────────────────
# (allow default) + gezielte Denies: Electron-/System-Frameworks bleiben
# unangetastet. deny file-write* auf die Caches fängt zusätzlich den inversen
# Fehler (Tool legt still Caches ausserhalb ~/.therascript an).
PROFILE="$(mktemp -t therascript-smoke).sb"
cat > "$PROFILE" <<EOF
(version 1)
(allow default)
(deny file-read* (subpath "/opt/homebrew"))
(deny file-read* (subpath "$HOME/.flair"))
(deny file-read* (subpath "$HOME/.cache/huggingface"))
(deny file-read* (subpath "$HOME/.cache/torch"))
(deny file-write* (subpath "$HOME/.flair"))
(deny file-write* (subpath "$HOME/.cache/huggingface"))
(deny file-write* (subpath "$HOME/.cache/torch"))
EOF

CLEAN_TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)"

# Führt einen Check in Sandbox + launchd-ähnlicher Minimal-Env aus.
# run_check <name> <erwartetes-grep-pattern-oder-leer> <cmd...>
PASS_LIST=""
FAIL_LIST=""
FAIL=0
run_check() {
  local name="$1"; shift
  local pattern="$1"; shift
  local output rc
  set +e
  output=$(sandbox-exec -f "$PROFILE" env -i \
    HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
    TMPDIR="$CLEAN_TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    __CF_USER_TEXT_ENCODING="$(id -u):0:0" PYTHONDONTWRITEBYTECODE=1 \
    "$@" 2>&1)
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    echo "FAIL [$name]: exit $rc" >&2
    echo "$output" | tail -8 >&2
    FAIL=1; FAIL_LIST="$FAIL_LIST $name"
    return
  fi
  if [ -n "$pattern" ] && ! printf '%s\n' "$output" | grep -q "$pattern"; then
    echo "FAIL [$name]: Output enthält '$pattern' nicht" >&2
    echo "$output" | tail -8 >&2
    FAIL=1; FAIL_LIST="$FAIL_LIST $name"
    return
  fi
  echo "ok   [$name]"
  PASS_LIST="$PASS_LIST $name"
}

# Ein Fehler, der ausserhalb von run_check passiert (z. B. Fixture-Erzeugung),
# muss trotzdem in FAIL_LIST und die Zusammenfassung — sonst reisst `set -e`
# das Script mittendrin ab und die restlichen Checks laufen stumm nicht mehr.
fail_check() {
  echo "FAIL [$1]: $2" >&2
  FAIL=1; FAIL_LIST="$FAIL_LIST $1"
}

skip_check() {
  if [ "$STRICT" = true ]; then
    echo "FAIL [$1]: $2 — im Gate-Modus (--app/--dist) sind Skips Fehler." >&2
    echo "       Fehlende Modelle installieren (setup-ner.sh --model / setup-llama.sh --model)" >&2
    echo "       bzw. sim-clean-install.sh --restore ausführen, dann erneut." >&2
    FAIL=1; FAIL_LIST="$FAIL_LIST $1"
  else
    echo "skip [$1]: $2"
  fi
}

echo ""
echo "=== Smoke-Checks (sandboxed, ohne /opt/homebrew und HF-/flair-Caches) ==="

# 1. whisper-cli: dylib-Closure lädt ohne Homebrew
if [ -x "$WHISPER_CLI" ]; then
  run_check 'whisper-cli' '' "$WHISPER_CLI" --help
else
  skip_check 'whisper-cli' "nicht gefunden: $WHISPER_CLI"
fi

# 2. llama-cli: --list-devices erzwingt den Backend-Plugin-dlopen. MTL0 im
#    Output beweist, dass die Plugins neben der Executable gefunden wurden —
#    bei fehlenden/falsch platzierten Plugins ist die Device-Liste LEER, aber
#    der Exit-Code bleibt 0 (verifiziert). Genau dort sass 77a1b7c; der
#    Homebrew-Cellar-Fallback ist durch die Sandbox tot, kann also nichts
#    maskieren.
if [ -x "$LLAMA_CLI" ]; then
  run_check 'llama-cli metal plugin' 'MTL0' "$LLAMA_CLI" --list-devices
else
  skip_check 'llama-cli metal plugin' "nicht gefunden: $LLAMA_CLI"
fi

# 2b. llama-cli CPU-Backend: --list-devices listet den CPU-Backend NICHT —
#     nur ein echter Modell-Load (make_cpu_buft_list) beweist, dass die
#     libggml-cpu-apple_*.so lädt. Braucht das installierte Summarization-
#     Modell (optional group — skip wenn nicht installiert).
GEMMA_MODEL="$HOME/.therascript/models/summarization/google_gemma-3-4b-it-Q4_K_M.gguf"
if [ -x "$LLAMA_CLI" ] && [ -f "$GEMMA_MODEL" ]; then
  run_check 'llama-cli generation (cpu buft)' '' \
    "$LLAMA_CLI" -m "$GEMMA_MODEL" -p 'Sag Hallo.' -st -n 8 -c 512 --no-warmup
else
  skip_check 'llama-cli generation (cpu buft)' "Summarization-Modell nicht installiert ($GEMMA_MODEL)"
fi

# 3. Standalone-Python: Interpreter + Native-Extension-Closure
if [ -x "$SIDECAR_PY" ]; then
  run_check 'python imports' '' "$SIDECAR_PY" -c 'import torch, flair, pyannote.audio'
else
  skip_check 'python imports' "nicht gefunden: $SIDECAR_PY"
fi

# 4. NER end-to-end: beweist Offline-Load aus ~/.therascript/models/ner
#    (inkl. hf/-Tokenizer-Subtree) ohne ~/.flair und ohne ~/.cache/huggingface
NER_MODEL_DIR="$HOME/.therascript/models/ner"
NER_READY=false
if [ -x "$SIDECAR_PY" ] && [ -f "$NER_SCRIPT" ] && [ -d "$NER_MODEL_DIR/models/ner-german-large" ]; then
  NER_READY=true
fi
if [ "$NER_READY" = true ]; then
  FIXTURE="$(mktemp -t therascript-ner-fixture).json"
  printf '%s' '{"segments":[{"text":"Dr. Müller wohnt in Bern."}]}' > "$FIXTURE"
  run_check 'ner offline e2e' '"entities"' \
    "$SIDECAR_PY" "$NER_SCRIPT" --transcript "$FIXTURE" --model-dir "$NER_MODEL_DIR"
  rm -f "$FIXTURE"
else
  skip_check 'ner offline e2e' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
fi

# 4a. NER page-sized PDF: seitengrosse Segmente (ein Segment pro PDF-Seite, wie
#     pdf-transcript-builder sie baut) sind 1–3 überlappende 512-Token-Zeilen
#     pro Segment, und flair padded jede Mini-Batch aufs längste Element. Der
#     Check beweist, dass genau diese Form den Token-Budget-Pfad in
#     pack_by_budget nimmt und e2e durchkommt. Assertiert wird
#     `[BATCH] sentences=[1-8]`: das Budget von 4096 Slots erlaubt bei
#     512er-Zeilen höchstens 8 Segmente pro Forward-Pass — eine Regression
#     zurück zu einer festen Batch-Grösse (Klasse ad9c716) würde hier
#     `sentences=11` emittieren und den Check rot machen. Das
#     Memory-Ceiling selbst ist hier NICHT reproduzierbar: es greift erst auf
#     8-GB-Macs (MPS-Limit 1.7 × ⅔ × RAM = 9.07 GiB), Dev-Macs haben mehr RAM
#     und überleben auch die alte feste Batch-Grösse 32.
if [ "$NER_READY" = true ]; then
  FIXTURE="$(mktemp -t therascript-ner-pagesized).json"
  # Fixture-Erzeugung wie beim diarize-Check (4b): ausgelieferter Interpreter
  # statt System-python3, set +e macht einen Fehlschlag zum roten Check statt
  # zum `set -e`-Abbruch mitten im Lauf.
  set +e
  PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" - "$FIXTURE" <<'PYPDF'
import json
import sys

# Realistischer deutscher Fliesstext mit Personennamen und Orten, wiederholt
# bis eine Seite voll ist (~2800 Zeichen — der gemessene Schnitt der Seiten,
# die auf 8-GB-Macs das MPS-Ceiling gerissen haben), dann 11 Seiten wie im
# Fehlerbericht.
PARAGRAPH = (
    "Der Verlaufsbericht wurde am 14. März von Dr. L. Anrig in Bern verfasst "
    "und anschliessend mit der Klientin besprochen. Sie arbeitet seit vier "
    "Jahren bei der Muster AG in Thun und schildert eine anhaltende Belastung "
    "am Arbeitsplatz, die sich vor allem in Schlafstörungen und "
    "Konzentrationsproblemen zeigt. Ihr Hausarzt, Dr. Peter Wyss aus "
    "Steffisburg, hatte sie im Januar zugewiesen; die Krankenkasse in Luzern "
    "wurde über die Verlängerung der Behandlung informiert. "
)

page = ""
while len(page) < 2800:
    page += PARAGRAPH

with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump(
        {"segments": [{"text": page} for _ in range(11)]}, out, ensure_ascii=False
    )
PYPDF
  fixture_rc=$?
  set -e
  if [ $fixture_rc -ne 0 ]; then
    fail_check 'ner page-sized pdf' "Fixture-Erzeugung fehlgeschlagen (exit $fixture_rc): $SIDECAR_PY"
  else
    run_check 'ner page-sized pdf' '\[BATCH\] sentences=[1-8] ' \
      "$SIDECAR_PY" "$NER_SCRIPT" --transcript "$FIXTURE" --model-dir "$NER_MODEL_DIR"
  fi
  rm -f "$FIXTURE"
else
  skip_check 'ner page-sized pdf' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
fi

# 4b. Diarization end-to-end: beweist den Offline-Load der Pipeline (inkl. der
#     transitiven Sub-Modelle segmentation-3.0 und wespeaker-…) aus
#     ~/.therascript/models/diarization, ohne ~/.cache/huggingface und
#     ~/.cache/torch. diarize.py pinnt dafür — wie ner_service.py — HF_HOME
#     unter das Modellverzeichnis; dieser Check ist das, was das Pinning
#     festhält. Ohne es stirbt der Modell-Load hier mit
#     "[Errno 1] Operation not permitted: ~/.cache/huggingface/token": die
#     Modelle kämen zwar über cache_dir=, aber huggingface_hub liest daneben
#     die Token-Datei, und einen PermissionError fängt es (anders als ein
#     fehlendes File) nicht ab. Wird der Check rot, gehört HF_HOME repariert —
#     NICHT das Sandbox-Deny gelockert.
#     Assertion ist "[PROGRESS] 100" (stderr, von run_check nach stdout
#     gemergt): das ist die letzte Zeile von main() und beweist damit Import,
#     Modell-Load, Inferenz und RTTM-Ausgabe. Auf RTTM-Zeilen zu prüfen wäre
#     falsch — auf einem Rauschen-Fixture darf pyannote legitim 0 Sprecher
#     finden.
DIARIZE_MODEL_DIR="$HOME/.therascript/models/diarization"
# Geprüft wird die Pipeline, die der Nutzer tatsächlich fährt
# (activeModels.diarizationPipeline aus electron-store), nicht pauschal der
# Katalog-Default: 3.1 und community-1 haben unterschiedliche Sub-Modell-Sätze,
# ein Cache-Layout-Fehler in genau der aktiven Pipeline wäre sonst grün durchs
# Gate gelaufen. Fällt das Lesen aus (App nie gestartet, kaputtes JSON,
# Modell nicht installiert), greift die Katalog-Reihenfolge als Fallback.
# electron-store legt die Datei unter <userData>/settings.json ab; userData ist
# für Dev und gepackte App identisch, weil electron-builder keinen productName
# setzt und damit package.json "name" gilt.
DIARIZE_SETTINGS="$HOME/Library/Application Support/therascript/settings.json"
DIARIZE_HF_MODEL=""
DIARIZE_PICK="Katalog-Default"

if [ -x "$SIDECAR_PY" ] && [ -f "$DIARIZE_SETTINGS" ]; then
  ACTIVE_PIPELINE="$(PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" -c '
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as f:
        print(json.load(f).get("activeModels", {}).get("diarizationPipeline") or "")
except Exception:
    pass
' "$DIARIZE_SETTINGS" 2>/dev/null || true)"
  # Nur ein pyannote-Bezeichner, dessen HF-Cache-Verzeichnis auch existiert —
  # sonst würde ein veralteter Store-Eintrag den Check rot machen, obwohl das
  # Bundle in Ordnung ist.
  case "$ACTIVE_PIPELINE" in
    pyannote/*)
      if [ -d "$DIARIZE_MODEL_DIR/models--${ACTIVE_PIPELINE//\//--}" ]; then
        DIARIZE_HF_MODEL="$ACTIVE_PIPELINE"
        DIARIZE_PICK="aktive Pipeline"
      fi
      ;;
  esac
fi

if [ -z "$DIARIZE_HF_MODEL" ]; then
  if [ -d "$DIARIZE_MODEL_DIR/models--pyannote--speaker-diarization-3.1" ]; then
    DIARIZE_HF_MODEL="pyannote/speaker-diarization-3.1"
  elif [ -d "$DIARIZE_MODEL_DIR/models--pyannote--speaker-diarization-community-1" ]; then
    DIARIZE_HF_MODEL="pyannote/speaker-diarization-community-1"
  fi
fi
if [ -x "$SIDECAR_PY" ] && [ -f "$DIARIZE_SCRIPT" ] && [ -n "$DIARIZE_HF_MODEL" ]; then
  echo "     Diarization-Pipeline: $DIARIZE_HF_MODEL ($DIARIZE_PICK)"
  FIXTURE="$(mktemp -t therascript-diarize-fixture).wav"
  # Fixture mit dem ausgelieferten Interpreter erzeugen — kein System-Python
  # nötig, sonst wäre der Gate-Check auf Maschinen ohne python3 ein FAIL.
  # PYTHONDONTWRITEBYTECODE, damit der Aufruf keine pyc-Caches ins signierte
  # Bundle schreibt (siehe CLAUDE.md / verify-bundles.sh).
  # set +e wie in run_check: schlägt der Interpreter hier fehl (z. B.
  # quarantänisiertes Binary → SIGKILL, exit 137), soll das ein roter Check
  # sein und keine Script-Abbruch durch `set -e` — sonst fehlen Summary,
  # FAIL_LIST und die danach folgenden Checks.
  set +e
  PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" - "$FIXTURE" <<'PYWAV'
import struct
import sys
import wave

# 5 s, 16 kHz, mono, 16-bit. Deterministisches Rauschen mit sehr kleiner
# Amplitude statt digitaler Stille: energiebasierte Normalisierungsschritte
# mögen einen Nullvektor nicht, und ein fester Seed hält den Check stabil.
state = 12345
frames = bytearray()
for _ in range(16000 * 5):
    state = (1103515245 * state + 12345) & 0x7FFFFFFF
    frames += struct.pack("<h", (state % 601) - 300)

with wave.open(sys.argv[1], "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(16000)
    out.writeframes(bytes(frames))
PYWAV
  fixture_rc=$?
  set -e
  if [ $fixture_rc -ne 0 ]; then
    fail_check 'diarize offline e2e' "Fixture-Erzeugung fehlgeschlagen (exit $fixture_rc): $SIDECAR_PY"
  else
    run_check 'diarize offline e2e' '\[PROGRESS\] 100' \
      "$SIDECAR_PY" "$DIARIZE_SCRIPT" --audio "$FIXTURE" \
      --model-dir "$DIARIZE_MODEL_DIR" --hf-model "$DIARIZE_HF_MODEL"
  fi
  rm -f "$FIXTURE"
else
  skip_check 'diarize offline e2e' "Diarization-Modell nicht installiert ($DIARIZE_MODEL_DIR)"
fi

# 5. vision-ocr: System-Framework-Binary startet
if [ -x "$VISION_OCR" ]; then
  run_check 'vision-ocr' '' "$VISION_OCR" --help
else
  skip_check 'vision-ocr' "nicht gefunden: $VISION_OCR"
fi

rm -f "$PROFILE"

echo ""
if [ $FAIL -ne 0 ]; then
  echo "SMOKE FAILED — fehlgeschlagen:$FAIL_LIST" >&2
  echo "Diese Tools würden auf einem Mac ohne Homebrew/Dev-Caches nicht laufen." >&2
  exit 1
fi
echo "SMOKE OK — alle gebundelten Tools laufen ohne Homebrew und Dev-Caches.$PASS_LIST"
