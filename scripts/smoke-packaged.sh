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
#   ... --ner-model-dir <pfad>                     # NER-Checks gegen ein anderes
#                                                  #   Modellverzeichnis, z. B. ein
#                                                  #   entpacktes R2-Artefakt vor dem
#                                                  #   Upload (Default ~/.therascript/models/ner)
#   ... --search-model-dir <pfad>                  # Such-Checks gegen ein entpacktes
#                                                  #   Text-Artefakt (Default ~/.therascript/
#                                                  #   models/search-embeddinggemma-2-text-v1)
#   ... --require-search                           # fehlendes Suchmodell ist ein Fehler
#                                                  #   (siehe «Such-Checks» unten)
#
# Exit: 0 wenn alle Checks grün, 1 sonst.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="/Applications/Therascript.app"
MODE="app"
NER_MODEL_DIR="$HOME/.therascript/models/ner"
SEARCH_MODEL_DIR="$HOME/.therascript/models/search-embeddinggemma-2-text-v1"
SEARCH_MODEL_EXPLICIT=false
REQUIRE_SEARCH=false
while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      if [ $# -lt 2 ]; then echo "FEHLER: --app braucht einen Pfad" >&2; exit 2; fi
      TARGET="$2"; MODE="app"; shift 2 ;;
    --dist) TARGET="$REPO_ROOT/dist/mac-arm64/Therascript.app"; MODE="app"; shift ;;
    --staging) MODE="staging"; shift ;;
    --ner-model-dir)
      if [ $# -lt 2 ]; then echo "FEHLER: --ner-model-dir braucht einen Pfad" >&2; exit 2; fi
      NER_MODEL_DIR="$2"; shift 2 ;;
    --search-model-dir)
      if [ $# -lt 2 ]; then echo "FEHLER: --search-model-dir braucht einen Pfad" >&2; exit 2; fi
      SEARCH_MODEL_DIR="$2"; SEARCH_MODEL_EXPLICIT=true; shift 2 ;;
    --require-search) REQUIRE_SEARCH=true; shift ;;
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
  SEARCH_SCRIPT="$RES/ml_sidecar/search_service.py"
  VISION_OCR="$RES/bin/vision-ocr"
  echo "Smoke-Target: $TARGET"
else
  WHISPER_CLI="$REPO_ROOT/resources/whisper/bin/whisper-cli"
  LLAMA_CLI="$REPO_ROOT/resources/llama/bin/llama-cli"
  SIDECAR_PY="$REPO_ROOT/python_sidecar/standalone/bin/python3"
  NER_SCRIPT="$REPO_ROOT/python_sidecar/ner_service.py"
  DIARIZE_SCRIPT="$REPO_ROOT/python_sidecar/diarize.py"
  SEARCH_SCRIPT="$REPO_ROOT/python_sidecar/search_service.py"
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

# Output des letzten run_check, für Checks die mehr als ein grep brauchen.
LAST_OUTPUT="$(mktemp -t therascript-smoke-out)"

# Wie run_check, legt den Output zusätzlich in $LAST_OUTPUT ab.
run_check_capture() {
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
  printf '%s\n' "$output" > "$LAST_OUTPUT"
  if [ $rc -ne 0 ]; then
    echo "FAIL [$name]: exit $rc" >&2
    echo "$output" | tail -8 >&2
    FAIL=1; FAIL_LIST="$FAIL_LIST $name"
    return 1
  fi
  if [ -n "$pattern" ] && ! printf '%s\n' "$output" | grep -q "$pattern"; then
    echo "FAIL [$name]: Output enthält '$pattern' nicht" >&2
    echo "$output" | tail -8 >&2
    FAIL=1; FAIL_LIST="$FAIL_LIST $name"
    return 1
  fi
  echo "ok   [$name]"
  PASS_LIST="$PASS_LIST $name"
  return 0
}

# Erzeugt eine Fixture mit dem ausgelieferten Interpreter; das Python-Programm
# kommt über stdin (Heredoc am Aufruf). Gründe für den Sidecar-Interpreter
# statt /usr/bin/python3: im Gate-Modus darf kein System-Python vorausgesetzt
# werden, und PYTHONDONTWRITEBYTECODE hält pyc-Caches aus dem signierten
# Bundle. Rückgabewert statt `set -e`-Abbruch, damit ein Fehlschlag als roter
# Check endet und die folgenden Checks noch laufen.
write_fixture() {
  local name="$1" out="$2" rc
  set +e
  PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" - "$out"
  rc=$?
  set -e
  if [ $rc -ne 0 ]; then
    fail_check "$name" "Fixture-Erzeugung fehlgeschlagen (exit $rc): $SIDECAR_PY"
    return 1
  fi
  return 0
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
GEMMA_MODEL="$HOME/.therascript/models/summarization/gemma-4-E2B_q4_0-it.gguf"
if [ -x "$LLAMA_CLI" ] && [ -f "$GEMMA_MODEL" ]; then
  run_check 'llama-cli generation (cpu buft)' '' \
    "$LLAMA_CLI" -m "$GEMMA_MODEL" -p 'Sag Hallo.' -st -n 8 -c 512 --no-warmup -rea off
  # 2c. Grammatik-Sampling mit der ECHTEN Grammatik aus LlamaSummarizer
  #     (--grammar SUMMARIZATION_GBNF + -rea off), gelesen aus dem Repo-Source
  #     derselben Revision. Mit --json-schema scheitert der Sampler-Init bei
  #     Gemma 4 und llama-cli exitet trotzdem 0 — nur der Output-Pattern fängt
  #     diesen Fehlermodus.
  SUMMARY_GBNF=$(cd "$REPO_ROOT" && node_modules/.bin/tsx -e \
    "import { SUMMARIZATION_GBNF } from './src/main/ml/summarization-schema'; process.stdout.write(SUMMARIZATION_GBNF)" \
    2>/dev/null || true)
  if [ -n "$SUMMARY_GBNF" ]; then
    run_check 'llama-cli grammar sampling' '"summary"' \
      "$LLAMA_CLI" -m "$GEMMA_MODEL" -st -n 256 -c 1024 --no-warmup -rea off \
      -p 'Fasse als JSON mit title und summary zusammen: Die Klientin berichtet von Schlafproblemen seit dem Jobwechsel. Vereinbart wird ein Schlaftagebuch.' \
      --grammar "$SUMMARY_GBNF"
  else
    skip_check 'llama-cli grammar sampling' 'SUMMARIZATION_GBNF nicht lesbar (node_modules/.bin/tsx fehlt?)'
  fi
else
  skip_check 'llama-cli generation (cpu buft)' "Summarization-Modell nicht installiert ($GEMMA_MODEL)"
fi

# 3. Standalone-Python: Interpreter + Native-Extension-Closure
if [ -x "$SIDECAR_PY" ]; then
  run_check 'python imports' '' "$SIDECAR_PY" -c 'import torch, flair, pyannote.audio'
else
  skip_check 'python imports' "nicht gefunden: $SIDECAR_PY"
fi

# 4. NER end-to-end + Token-Budget: EIN Sidecar-Lauf beweist beides, weil jeder
#    Lauf den flair-Import und den 1.1–2.2 GB grossen Checkpoint lädt — zwei getrennte
#    Checks verdoppelten das im Release-Gate.
#    (a) Offline-Load aus ~/.therascript/models/ner (inkl. hf/-Tokenizer-Subtree)
#        ohne ~/.flair und ohne ~/.cache/huggingface → Assert auf "entities".
#    (b) Token-Budget-Pfad: die Fixture enthält 11 seitengrosse Segmente (ein
#        Segment pro PDF-Seite, wie pdf-transcript-builder sie baut = je 1–3
#        überlappende 512-Token-Zeilen). Der Folge-Check 'ner token budget'
#        prüft die [BATCH]-Zeilen gegen das aus ner_service.py IMPORTIERTE
#        TOKEN_BUDGET — nicht gegen eine hartkodierte Gruppengrösse, die bei
#        jeder Budget-Änderung still falsch würde.
#    Das Memory-Ceiling selbst ist hier NICHT reproduzierbar: es greift erst auf
#    8-GB-Macs (MPS-Limit 1.7 × ⅔ × RAM = 9.07 GiB), Dev-Macs überleben auch
#    die alte feste Batch-Grösse 32.
if [ -x "$SIDECAR_PY" ] && [ -f "$NER_SCRIPT" ] && [ -d "$NER_MODEL_DIR/models/ner-german-large" ]; then
  FIXTURE="$(mktemp -t therascript-ner-fixture).json"
  if write_fixture 'ner offline e2e' "$FIXTURE" <<'PYNER'
import json
import sys

# Ein kurzes Segment (Audio-Profil) + 11 seitengrosse (PDF-Profil). Die Seiten
# müssen lang genug sein, dass sie NICHT alle in eine Budget-Gruppe passen —
# ~2800 Zeichen ist der gemessene Schnitt der Seiten, die auf 8-GB-Macs das
# MPS-Ceiling gerissen haben.
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

segments = [{"text": "Dr. Müller wohnt in Bern."}]
segments += [{"text": page} for _ in range(11)]

with open(sys.argv[1], "w", encoding="utf-8") as out:
    json.dump({"segments": segments}, out, ensure_ascii=False)
PYNER
  then
    if run_check_capture 'ner offline e2e' '"entities"' \
      "$SIDECAR_PY" "$NER_SCRIPT" --transcript "$FIXTURE" --model-dir "$NER_MODEL_DIR"
    then
      set +e
      PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" - "$LAST_OUTPUT" "$NER_SCRIPT" <<'PYBUDGET'
import os
import re
import sys

# TOKEN_BUDGET aus dem GEBUNDELTEN ner_service.py importieren, damit der Check
# eine Budget-Änderung mitzieht statt sie stumm zu übergehen. Der Import ist
# nebenwirkungsfrei: die Top-Level-Zeilen sind reine stdlib, flair/torch werden
# erst in run_ner importiert (darauf baut auch der Vitest ner-packing.test.ts).
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[2])))
from ner_service import TOKEN_BUDGET

LINE = re.compile(r"\[BATCH\] sentences=(\d+) rows=(\d+) padded=(\d+) budget=(\d+)")

batches = [tuple(map(int, m.groups())) for m in map(LINE.search, open(sys.argv[1])) if m]

if not batches:
    sys.exit("keine [BATCH]-Zeile im Output — Format geändert?")

# Eine feste Batch-Grösse (Regression der Klasse ad9c716) packte alle 12
# Segmente in EINEN Forward-Pass.
if len(batches) < 2:
    sys.exit(f"nur {len(batches)} Forward-Pass — Budget hat nicht gruppiert: {batches}")

for sentences, rows, padded, budget in batches:
    if budget != TOKEN_BUDGET:
        sys.exit(f"budget={budget} != TOKEN_BUDGET={TOKEN_BUDGET} (kein OOM erwartet)")
    # Die Invariante, die pack_by_budget garantiert. Nur Gruppen mit einem
    # einzigen Segment dürfen sie reissen (ein Segment ist unteilbar).
    if sentences > 1 and rows * padded > budget:
        sys.exit(f"Gruppe über Budget: {rows}×{padded} > {budget} (sentences={sentences})")

print(f"ok: {len(batches)} Forward-Pässe, alle innerhalb TOKEN_BUDGET={TOKEN_BUDGET}")
PYBUDGET
      budget_rc=$?
      set -e
      if [ $budget_rc -ne 0 ]; then
        fail_check 'ner token budget' "Budget-Invariante verletzt (exit $budget_rc)"
      else
        echo "ok   [ner token budget]"
        PASS_LIST="$PASS_LIST ner-token-budget"
      fi

      # Ladepfad. Erwartung aus einem Signal, das NICHT aus ner_service.py
      # stammt — sonst prüfte der Check die Erkennung gegen sich selbst: die
      # Grösse des Original-Blobs. fp16 (Artefakt v3, 1.1 GB) muss als kompakt
      # gelten und darf keine Fast-Kopie hinterlassen (sie brächte nichts);
      # fp32 (v1/v2, 2.2 GB) muss den Fast-Kopie-Pfad nehmen (sonst lädt jeder
      # Lauf ~8 s länger).
      NER_ORIGINAL=$(compgen -G "$NER_MODEL_DIR/models/ner-german-large/models--flair--ner-german-large/snapshots/*/pytorch_model.bin" | head -1 || true)
      if [ -z "$NER_ORIGINAL" ]; then
        fail_check 'ner load path' 'Original-Checkpoint nicht gefunden'
      else
        NER_ORIGINAL_BYTES=$(stat -L -f%z "$NER_ORIGINAL")
        NER_SAYS_COMPACT=false
        grep -q 'Original-Checkpoint ist kompakt' "$LAST_OUTPUT" && NER_SAYS_COMPACT=true
        if [ "$NER_ORIGINAL_BYTES" -lt 1600000000 ]; then
          if [ "$NER_SAYS_COMPACT" != true ]; then
            fail_check 'ner load path' "fp16-Original ($NER_ORIGINAL_BYTES Bytes) nicht als kompakt erkannt"
          elif compgen -G "$NER_MODEL_DIR/*-fast.pt" > /dev/null; then
            fail_check 'ner load path' 'Fast-Kopie neben kompaktem fp16-Original'
          else
            echo "ok   [ner load path] (fp16-Original, keine Fast-Kopie)"
            PASS_LIST="$PASS_LIST ner-load-path"
          fi
        elif [ "$NER_SAYS_COMPACT" = true ]; then
          fail_check 'ner load path' "fp32-Original ($NER_ORIGINAL_BYTES Bytes) fälschlich als kompakt erkannt"
        else
          echo "ok   [ner load path] (fp32-Original mit Fast-Kopie-Pfad)"
          PASS_LIST="$PASS_LIST ner-load-path"
        fi
      fi

      # Präzision. Mit aktivem MPS MUSS der Tagger als fp16 auf der GPU liegen
      # (_half_precision_on): fiele er still auf fp32 zurück (z. B. ein
      # torch-Update, das set_default_dtype(float16) oder den Device-Kontext
      # ändert), läge der Prozess-Peak auf 8-GB-Macs wieder bei ~9.4 GiB und
      # die Anonymisierung endete im 900-s-Timeout — auf Dev-Macs unsichtbar.
      if grep -q 'MPS-Backend aktiv' "$LAST_OUTPUT"; then
        NER_EXPECTED_WEIGHTS='Gewichte: torch.float16 auf mps'
      else
        NER_EXPECTED_WEIGHTS='Gewichte: torch.float32 auf cpu'
      fi
      if grep -q "$NER_EXPECTED_WEIGHTS" "$LAST_OUTPUT"; then
        echo "ok   [ner precision] ($NER_EXPECTED_WEIGHTS)"
        PASS_LIST="$PASS_LIST ner-precision"
      else
        fail_check 'ner precision' "erwartet '$NER_EXPECTED_WEIGHTS', gefunden: $(grep -m1 'Gewichte:' "$LAST_OUTPUT" || echo 'keine Gewichte-Zeile')"
      fi

      # OOM-Notpfad. Auf Dev-Macs reisst MPS nie sein Limit — Budget-Halbierung
      # und CPU-Fallback in run_ner liefen deshalb nur auf 8-GB-Macs, und genau
      # dort endete ein Fehler darin (to(cpu, float32) castete auf der GPU)
      # als Exit 3 statt als CPU-Lauf. Hier wird das MPS-Limit auf 1.6 GiB
      # gedrückt: genug für die fp16-Gewichte (1.1 GiB), zu wenig für eine
      # Seiten-Gruppe — der Lauf MUSS halbieren, auf die CPU wechseln und
      # trotzdem fertig werden. Die Watermarks sind Faktoren auf torchs
      # recommended_max_memory, deshalb aus dieser Maschine berechnet.
      if grep -q 'MPS-Backend aktiv' "$LAST_OUTPUT"; then
        NER_OOM_RATIOS=$(PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" -c '
import torch
high = 1.6 * 1024**3 / torch.mps.recommended_max_memory()
print(f"{high:.6f} {high * 0.8:.6f}")
' 2>/dev/null || true)
        if [ -z "$NER_OOM_RATIOS" ]; then
          fail_check 'ner oom fallback' 'MPS-Limit nicht berechenbar (torch.mps.recommended_max_memory)'
        else
          read -r NER_OOM_HIGH NER_OOM_LOW <<< "$NER_OOM_RATIOS"
          run_check_capture 'ner oom fallback' 'wechsle auf CPU' \
            env PYTORCH_MPS_HIGH_WATERMARK_RATIO="$NER_OOM_HIGH" \
            PYTORCH_MPS_LOW_WATERMARK_RATIO="$NER_OOM_LOW" \
            "$SIDECAR_PY" "$NER_SCRIPT" --transcript "$FIXTURE" --model-dir "$NER_MODEL_DIR" || true
        fi
      else
        skip_check 'ner oom fallback' 'kein MPS-Backend aktiv'
      fi
    else
      fail_check 'ner token budget' 'übersprungen — ner offline e2e ist rot'
      fail_check 'ner load path' 'übersprungen — ner offline e2e ist rot'
      fail_check 'ner precision' 'übersprungen — ner offline e2e ist rot'
      fail_check 'ner oom fallback' 'übersprungen — ner offline e2e ist rot'
    fi
  fi
  rm -f "$FIXTURE"
else
  skip_check 'ner offline e2e' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
  skip_check 'ner token budget' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
  skip_check 'ner load path' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
  skip_check 'ner precision' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
  skip_check 'ner oom fallback' "NER-Modell nicht installiert ($NER_MODEL_DIR)"
fi

# 4a. load_waveform (diarize.py) setzt das Resampling blockweise zusammen
#     (Issue #141) — die Grenz-Arithmetik muss dasselbe liefern wie
#     torchaudio am Stück. Der e2e-Check unten deckt das nicht ab: seine 5-s-
#     Fixture passt in einen einzigen Block. Geprüft wird mit 2-s-Blöcken auf
#     7.3 s (vier Blöcke, kurzer letzter Block) — die Arithmetik hängt nicht
#     von der Blocklänge ab, und die 60-s-Produktionsblöcke bräuchten eine
#     >2-min-Fixture plus ~1 GB für die Referenz am Stück (im2col). Drei Fälle:
#     48 kHz (App-Aufnahmen), 44.1 kHz Stereo (andere GCD-Kürzung + Downmix)
#     und 16 kHz (Zweig ohne Resampling). Braucht kein Modell.
if [ -x "$SIDECAR_PY" ] && [ -f "$DIARIZE_SCRIPT" ]; then
  run_check 'diarize waveform blocks' 'waveform blocks ok' \
    "$SIDECAR_PY" - "$DIARIZE_SCRIPT" <<'PYBLOCKS'
import importlib.util
import os
import sys
import tempfile

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional

spec = importlib.util.spec_from_file_location("diarize", sys.argv[1])
diarize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diarize)
diarize.BLOCK_SECONDS = 2

rng = np.random.default_rng(141)
with tempfile.TemporaryDirectory() as tmp:
    for rate, channels in ((48000, 1), (44100, 2), (16000, 1)):
        path = os.path.join(tmp, f"{rate}-{channels}.wav")
        noise = rng.standard_normal((int(rate * 7.3), channels)) * 0.1
        sf.write(path, noise.astype("float32"), rate, subtype="PCM_16")
        got = diarize.load_waveform(path, 16000)
        data, _ = sf.read(path, dtype="float32", always_2d=True)
        ref = torch.from_numpy(data.T).mean(dim=0, keepdim=True)
        if rate != 16000:
            ref = torchaudio.functional.resample(ref, rate, 16000)
        if got.shape != ref.shape:
            sys.exit(f"{rate} Hz/{channels} ch: Form {tuple(got.shape)} statt {tuple(ref.shape)}")
        diff = (got - ref).abs().max().item()
        if diff > 1e-6:
            sys.exit(f"{rate} Hz/{channels} ch: max. Abweichung {diff:.1e} > 1e-6")
        print(f"{rate} Hz/{channels} ch: max. Abweichung {diff:.1e}")
print("waveform blocks ok")
PYBLOCKS
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
  if write_fixture 'diarize offline e2e' "$FIXTURE" <<'PYWAV'
import struct
import sys
import wave

# 5 s, 48 kHz, mono, 16-bit. Deterministisches Rauschen mit sehr kleiner
# Amplitude statt digitaler Stille: energiebasierte Normalisierungsschritte
# mögen einen Nullvektor nicht, und ein fester Seed hält den Check stabil.
# 48 kHz wie die App-Aufnahmen: so läuft auch der Resampling-Schritt in
# diarize.py (torchaudio.functional.resample → 16 kHz) gegen den gebundelten
# Interpreter — bei 16 kHz würde er übersprungen.
state = 12345
frames = bytearray()
for _ in range(48000 * 5):
    state = (1103515245 * state + 12345) & 0x7FFFFFFF
    frames += struct.pack("<h", (state % 601) - 300)

with wave.open(sys.argv[1], "wb") as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(48000)
    out.writeframes(bytes(frames))
PYWAV
  then
    if run_check_capture 'diarize offline e2e' '\[PROGRESS\] 100' \
      "$SIDECAR_PY" "$DIARIZE_SCRIPT" --audio "$FIXTURE" \
      --model-dir "$DIARIZE_MODEL_DIR" --hf-model "$DIARIZE_HF_MODEL"; then
      # Ohne Preload liest pyannote jeden Embedding-Chunk einzeln von der
      # Platte (Issue #141) — funktional korrekt, deshalb fiele ein Rückfall
      # nach einem pyannote-Update sonst durch jeden anderen Check.
      if grep -q 'Audio vorab geladen' "$LAST_OUTPUT"; then
        echo "ok   [diarize waveform preload]"
        PASS_LIST="$PASS_LIST diarize-waveform-preload"
      else
        fail_check 'diarize waveform preload' 'diarize.py liest vom Dateipfad statt aus dem Speicher'
      fi
    fi
  fi
  rm -f "$FIXTURE"
else
  skip_check 'diarize offline e2e' "Diarization-Modell nicht installiert ($DIARIZE_MODEL_DIR)"
fi

# 4c. Suchdienst (search_service.py, Epic #192). Vier Checks gegen das
#     entpackte Text-Artefakt, sandboxed wie alle anderen:
#     - search load:   `serve` meldet bereit, beantwortet embed_query mit einem
#                      normalisierten 768er-Vektor, stdout trägt NUR
#                      Protokollzeilen, und die Vertragszeile lautet mit MPS
#                      `Gewichte: torch.bfloat16 auf mps` — nie float16 (Gemma
#                      überläuft), nie still float32 auf der CPU.
#     - search eof:    stdin schliessen → Exit 0 in < 2 s (der Worker in Node
#                      verlässt sich darauf, keine Waisen).
#     - search parity: selftest gegen die Goldvektoren aus sentence-transformers
#                      (tests/fixtures/search-golden/, aus dem Repo derselben
#                      Revision wie die SUMMARIZATION_GBNF oben), auf dem
#                      Standardgerät: Kosinus ≥ 0.999 in bf16 auf MPS.
#     - search parity cpu: derselbe Vergleich in fp32 auf der CPU, Kosinus
#                      ≥ 0.9999995. Nur hier fallen Off-by-one-Fehler im
#                      Encoder auf (Sliding Window, Kürzung) — das bf16-
#                      Rauschen auf MPS ist grösser als ihr Effekt.
#     - search memory: phys_footprint-Peak beim Aufbereiten von 40 Abschnitten
#                      < 2.5 GiB (RSS zählt MPS nicht mit).
#     Ohne Modell, aber immer: `search script` — `--help` läuft und `serve`
#     auf ein leeres Verzeichnis endet mit Exit 2 bei leerem stdout. So fällt
#     ein Syntax- oder Importfehler im gebundelten Skript in jedem Release auf.
#
#     Skip-Regel — bewusst anders als bei NER/Diarization: solange das
#     Suchmodell nicht auf R2 liegt, hat KEIN Mac es installiert, auch der
#     Release-Mac nicht. Ein Skip im Gate-Modus wäre dann ein Fehler und jeder
#     Release bis zum Upload rot. Deshalb: fehlt das Modell am Default-Ort,
#     wird nur gemeldet (auch im Gate-Modus nicht rot). Ein Fehler ist es — in
#     JEDEM Modus —, wenn --search-model-dir auf ein fehlendes Modell zeigt
#     oder --require-search gesetzt ist. release.sh setzt --require-search
#     (über verify-bundles.sh --smoke --require-search), sobald das Modell im
#     Katalog veröffentlicht ist (Epic #192, PR S2/S6). Liegt das Modell da,
#     laufen die Checks immer und zählen voll.
SEARCH_GOLDEN="$REPO_ROOT/tests/fixtures/search-golden/golden.json"
SEARCH_MAX_FOOTPRINT_GIB=2.5
SEARCH_CHECKS=('search load' 'search eof' 'search parity' 'search parity cpu' 'search memory')
if [ ! -f "$SEARCH_SCRIPT" ]; then
  fail_check 'search script' "search_service.py fehlt: $SEARCH_SCRIPT"
elif [ ! -x "$SIDECAR_PY" ]; then
  skip_check 'search script' "Python-Interpreter fehlt: $SIDECAR_PY"
else
  run_check 'search script' 'search script ok' \
    "$SIDECAR_PY" - "$SIDECAR_PY" "$SEARCH_SCRIPT" <<'PYSCRIPT'
import subprocess
import sys

python, script = sys.argv[1:3]
env = {"PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"}
help_run = subprocess.run([python, script, "--help"], capture_output=True, text=True, env=env)
if help_run.returncode != 0 or "selftest" not in help_run.stdout:
    sys.exit(f"--help: Exit {help_run.returncode}: {help_run.stderr[-300:]}")
missing = subprocess.run(
    [python, script, "serve", "--model-dir", "/nonexistent-therascript-search"],
    capture_output=True, text=True, env=env, timeout=60,
)
if missing.returncode != 2 or missing.stdout:
    sys.exit(f"serve ohne Modell: Exit {missing.returncode} statt 2, stdout {missing.stdout[:200]!r}")
print("search script ok")
PYSCRIPT
fi
if [ -x "$SIDECAR_PY" ] && [ -f "$SEARCH_SCRIPT" ] \
  && [ -f "$SEARCH_MODEL_DIR/READY" ] && [ -f "$SEARCH_MODEL_DIR/model.safetensors" ]; then
  echo "     Suchmodell: $SEARCH_MODEL_DIR"
  if run_check_capture 'search serve' '' \
    "$SIDECAR_PY" - "$SIDECAR_PY" "$SEARCH_SCRIPT" "$SEARCH_MODEL_DIR" <<'PYSEARCH'
import base64
import json
import os
import struct
import subprocess
import sys
import threading
import time

python, script, model_dir = sys.argv[1:4]
env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
proc = subprocess.Popen(
    [python, script, "serve", "--model-dir", model_dir],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
)
stderr_lines = []
threading.Thread(target=lambda: stderr_lines.extend(proc.stderr), daemon=True).start()


def read_line(timeout):
    box = []
    reader = threading.Thread(target=lambda: box.append(proc.stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout)
    return box[0] if box else None


def fail(check, message):
    print(f"{check}_FAIL {message}")


load_ok = False
try:
    first = read_line(180)
    ready = json.loads(first) if first else None
    if not ready or ready.get("ready") is not True or ready.get("dim") != 768:
        fail("SEARCH_LOAD", f"keine gültige Startzeile: {first!r}")
    else:
        proc.stdin.write(b'{"id":"smoke","op":"embed_query","text":"Schlafprobleme wegen der Arbeit"}\n')
        proc.stdin.flush()
        line = read_line(60)
        answer = json.loads(line) if line else {}
        raw = base64.b64decode(answer.get("vector", ""))
        vector = struct.unpack(f"<{len(raw) // 4}f", raw)
        norm = sum(x * x for x in vector) ** 0.5
        if answer.get("id") != "smoke" or len(vector) != 768 or abs(norm - 1) > 1e-3:
            fail("SEARCH_LOAD", f"embed_query-Antwort ungültig: {line!r:.200}")
        else:
            import torch

            mps = torch.backends.mps.is_available()
            expected = "Gewichte: torch.bfloat16 auf mps" if mps else "Gewichte: torch.float32 auf cpu"
            time.sleep(0.2)
            weights = [l.decode().strip() for l in stderr_lines if l.startswith(b"Gewichte:")]
            if expected not in weights:
                fail("SEARCH_LOAD", f"erwartet '{expected}', gefunden {weights}")
            else:
                load_ok = True
                print(f"SEARCH_LOAD_OK {ready['device']}/{ready['dtype']}, load_ms={ready['load_ms']}")
finally:
    started = time.perf_counter()
    proc.stdin.close()
    try:
        rc = proc.wait(timeout=2.0)
        elapsed = time.perf_counter() - started
        rest = proc.stdout.read()
        if rc != 0:
            fail("SEARCH_EOF", f"Exit {rc} statt 0")
        elif rest.strip():
            # stdout darf nichts ausser Protokollzeilen tragen
            fail("SEARCH_EOF", f"unerwartete stdout-Ausgabe: {rest[:200]!r}")
        else:
            print(f"SEARCH_EOF_OK Exit 0 nach {elapsed:.2f} s")
    except subprocess.TimeoutExpired:
        proc.kill()
        fail("SEARCH_EOF", "nach stdin-EOF nicht binnen 2 s beendet")
print("stderr:", "".join(l.decode(errors="replace") for l in stderr_lines[-5:]))
PYSEARCH
  then
    for marker in LOAD EOF; do
      name="search $(echo "$marker" | tr '[:upper:]' '[:lower:]')"
      if grep -q "^SEARCH_${marker}_OK" "$LAST_OUTPUT"; then
        echo "ok   [$name] ($(grep -m1 "^SEARCH_${marker}_OK" "$LAST_OUTPUT" | cut -d' ' -f2-))"
        PASS_LIST="$PASS_LIST ${name// /-}"
      else
        fail_check "$name" "$(grep -m1 "^SEARCH_${marker}_FAIL" "$LAST_OUTPUT" || echo 'kein Ergebnis')"
      fi
    done
  else
    fail_check 'search load' 'Treiber für den Suchdienst ist abgestürzt'
    fail_check 'search eof' 'Treiber für den Suchdienst ist abgestürzt'
  fi

  if [ ! -f "$SEARCH_GOLDEN" ]; then
    fail_check 'search parity' "Goldvektoren fehlen: $SEARCH_GOLDEN"
    fail_check 'search memory' "Goldvektoren fehlen: $SEARCH_GOLDEN"
  elif run_check_capture 'search parity' 'search parity ok' \
    "$SIDECAR_PY" "$SEARCH_SCRIPT" selftest --model-dir "$SEARCH_MODEL_DIR" \
    --golden "$SEARCH_GOLDEN" --bench 40; then
    set +e
    SEARCH_MEMORY=$(PYTHONDONTWRITEBYTECODE=1 "$SIDECAR_PY" - "$LAST_OUTPUT" "$SEARCH_MAX_FOOTPRINT_GIB" <<'PYMEM'
import json
import sys

report = next(json.loads(l) for l in open(sys.argv[1]) if l.startswith("{"))
bench = report["bench"]
peak = bench["phys_footprint_peak_bytes"]
limit = float(sys.argv[2]) * 1024**3
print(f"Peak {peak / 1024**3:.2f} GiB bei {bench['chunks']} Abschnitten "
      f"(Ø {bench['tokens_mean']} Tokens), {bench['ms_per_chunk']:.0f} ms pro Abschnitt, "
      f"min. Kosinus {report['min_cosine']}")
sys.exit(0 if peak is not None and peak < limit else 1)
PYMEM
)
    memory_rc=$?
    set -e
    if [ $memory_rc -eq 0 ]; then
      echo "ok   [search memory] ($SEARCH_MEMORY)"
      PASS_LIST="$PASS_LIST search-memory"
    else
      fail_check 'search memory' "über ${SEARCH_MAX_FOOTPRINT_GIB} GiB oder nicht messbar: $SEARCH_MEMORY"
    fi
  else
    fail_check 'search memory' 'übersprungen — search parity ist rot'
  fi

  if [ -f "$SEARCH_GOLDEN" ]; then
    run_check_capture 'search parity cpu' 'search parity ok' \
      env THERASCRIPT_SEARCH_DEVICE=cpu \
      "$SIDECAR_PY" "$SEARCH_SCRIPT" selftest --model-dir "$SEARCH_MODEL_DIR" \
      --golden "$SEARCH_GOLDEN" || true
  else
    fail_check 'search parity cpu' "Goldvektoren fehlen: $SEARCH_GOLDEN"
  fi
elif [ ! -x "$SIDECAR_PY" ] || [ ! -f "$SEARCH_SCRIPT" ]; then
  for check in "${SEARCH_CHECKS[@]}"; do
    if [ "$SEARCH_MODEL_EXPLICIT" = true ] || [ "$REQUIRE_SEARCH" = true ]; then
      fail_check "$check" "Python ($SIDECAR_PY) oder search_service.py ($SEARCH_SCRIPT) fehlt"
    else
      skip_check "$check" "Python ($SIDECAR_PY) oder search_service.py ($SEARCH_SCRIPT) fehlt"
    fi
  done
elif [ "$SEARCH_MODEL_EXPLICIT" = true ] || [ "$REQUIRE_SEARCH" = true ]; then
  for check in "${SEARCH_CHECKS[@]}"; do
    fail_check "$check" "kein Suchmodell in $SEARCH_MODEL_DIR (READY/model.safetensors fehlen)"
  done
else
  for check in "${SEARCH_CHECKS[@]}"; do
    echo "skip [$check]: Suchmodell nicht installiert ($SEARCH_MODEL_DIR) — noch kein Pflichtmodell, erst mit --require-search ein Fehler"
  done
fi

# 5. vision-ocr: System-Framework-Binary startet
if [ -x "$VISION_OCR" ]; then
  run_check 'vision-ocr' '' "$VISION_OCR" --help
else
  skip_check 'vision-ocr' "nicht gefunden: $VISION_OCR"
fi

rm -f "$PROFILE" "$LAST_OUTPUT"

echo ""
if [ $FAIL -ne 0 ]; then
  echo "SMOKE FAILED — fehlgeschlagen:$FAIL_LIST" >&2
  echo "Diese Tools würden auf einem Mac ohne Homebrew/Dev-Caches nicht laufen." >&2
  exit 1
fi
echo "SMOKE OK — alle gebundelten Tools laufen ohne Homebrew und Dev-Caches.$PASS_LIST"
