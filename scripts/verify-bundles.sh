#!/usr/bin/env bash
#
# Pre-Release-Verifikation über alle Bundle-Bausteine:
#   1. whisper/llama-Bundles self-contained (keine /opt/homebrew-Refs,
#      keine Dylib-Duplikate, alle @rpath-Refs auflösbar)
#   2. Python-Sidecar geprunt (kein __pycache__/torch-include/pip) und ohne
#      absolute LC_LOAD-Refs auf /opt/homebrew oder /Users
#   3. vision-ocr ohne /opt/homebrew-Refs
#   4. LC_RPATH-Einträge nur @loader_path/@executable_path-relativ
#   5. app.asar (falls gepackt): keine Secret-/Ballast-Leaks, Runtime-Deps
#      vorhanden, Resolve-Gate via verify-asar-resolves.mjs
#
# Usage:
#   ./scripts/verify-bundles.sh                  # prüft den Repo-Staging-Tree
#   ./scripts/verify-bundles.sh --app <pfad>     # prüft die GEPACKTE .app
#                                                #   (dist/mac-arm64/Therascript.app)
#   ./scripts/verify-bundles.sh --app <pfad> --smoke
#                                                # zusätzlich Runtime-Smoke-Tests
#                                                #   (scripts/smoke-packaged.sh)
#
# --app schliesst die Lücke "Staging geprüft, .app geshippt": electron-builder
# könnte Dateien droppen oder beim Re-Sign beschädigen — geprüft wird, was
# tatsächlich im Bundle liegt.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

APP_PATH=""
RUN_SMOKE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      if [ $# -lt 2 ]; then echo "FEHLER: --app braucht einen Pfad" >&2; exit 2; fi
      APP_PATH="$2"; shift 2 ;;
    --smoke) RUN_SMOKE=true; shift ;;
    *) echo "FEHLER: unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$APP_PATH" ] && [ ! -d "$APP_PATH/Contents/Resources" ]; then
  echo "FEHLER: $APP_PATH ist keine .app (Contents/Resources fehlt)" >&2
  exit 2
fi

FAIL=0

check_no_homebrew_refs() {
  local label="$1"; shift
  local found
  found=$(otool -L "$@" 2>/dev/null | grep -E '^\s+/opt/homebrew' || true)
  if [ -n "$found" ]; then
    echo "FAIL [$label]: absolute /opt/homebrew references in:" >&2
    echo "$found" >&2
    FAIL=1
  else
    echo "ok   [$label]: zero /opt/homebrew references"
  fi
}

check_file_present() {
  local label="$1"; local path="$2"
  if [ ! -f "$path" ]; then
    echo "FAIL [$label]: missing $path" >&2
    FAIL=1
  else
    echo "ok   [$label]: $path"
  fi
}

# LC_RPATH-Gate: absolute rpath-Einträge unter /opt/homebrew oder /Users lösen
# @rpath-Refs auf dem Dev-Mac auf und maskieren fehlende Bundle-Dateien —
# otool -L zeigt sie nicht (nur die Dependency-Pfade), darum eigener Check.
check_rpaths_relative() {
  local label="$1"; shift
  local bad
  bad=$(otool -l "$@" 2>/dev/null | awk '
    $1 == "cmd" { cmd=$2 }
    $1 == "path" && cmd == "LC_RPATH" && ($2 ~ /^\/opt\/homebrew/ || $2 ~ /^\/Users\//) { print $2 }
  ' | sort -u)
  if [ -n "$bad" ]; then
    echo "FAIL [$label]: absolute LC_RPATH entries (masken Bundle-Fehler auf Dev-Macs):" >&2
    echo "$bad" >&2
    FAIL=1
  else
    echo "ok   [$label]: no absolute LC_RPATH entries"
  fi
}

if [ -n "$APP_PATH" ]; then
  RES="$APP_PATH/Contents/Resources"
  WHISPER_BIN="$RES/whisper/bin/whisper-cli"
  WHISPER_LIB="$RES/whisper/lib"
  LLAMA_BIN="$RES/llama/bin/llama-cli"
  LLAMA_BIN_DIR="$RES/llama/bin"
  LLAMA_LIB="$RES/llama/lib"
  SIDECAR="$RES/ml_sidecar/standalone"
  VISION_OCR="$RES/bin/vision-ocr"
  ASAR="$RES/app.asar"
  echo "Prüfe gepackte App: $APP_PATH"
else
  WHISPER_BIN="$REPO_ROOT/resources/whisper/bin/whisper-cli"
  WHISPER_LIB="$REPO_ROOT/resources/whisper/lib"
  LLAMA_BIN="$REPO_ROOT/resources/llama/bin/llama-cli"
  LLAMA_BIN_DIR="$REPO_ROOT/resources/llama/bin"
  LLAMA_LIB="$REPO_ROOT/resources/llama/lib"
  SIDECAR="$REPO_ROOT/python_sidecar/standalone"
  VISION_OCR="$REPO_ROOT/resources/bin/vision-ocr"
  ASAR="$REPO_ROOT/dist/mac-arm64/Therascript.app/Contents/Resources/app.asar"
fi

echo "=== whisper bundle ==="
check_file_present 'whisper-cli'        "$WHISPER_BIN"
check_file_present 'libwhisper.1.dylib' "$WHISPER_LIB/libwhisper.1.dylib"
check_file_present 'libggml.0.dylib'    "$WHISPER_LIB/libggml.0.dylib"
check_no_homebrew_refs 'whisper bundle' "$WHISPER_BIN" "$WHISPER_LIB/"*.dylib

echo ""
echo "=== llama bundle ==="
check_file_present 'llama-cli'              "$LLAMA_BIN"
check_file_present 'libllama.0.dylib'       "$LLAMA_LIB/libllama.0.dylib"
check_file_present 'libggml.0.dylib'        "$LLAMA_LIB/libggml.0.dylib"
check_file_present 'libssl.3.dylib'         "$LLAMA_LIB/libssl.3.dylib"
check_file_present 'libcrypto.3.dylib'      "$LLAMA_LIB/libcrypto.3.dylib"
check_file_present 'libomp.dylib'           "$LLAMA_LIB/libomp.dylib"
check_file_present 'libggml-metal.so'       "$LLAMA_BIN_DIR/libggml-metal.so"
check_file_present 'libggml-blas.so'        "$LLAMA_BIN_DIR/libggml-blas.so"
# At least one CPU backend variant must be present (apple_m1/m2_m3/m4 cover
# all current Apple Silicon Macs).
# Plugins MÜSSEN neben der Executable liegen (bin/): ggml scannt das
# Executable-Verzeichnis; lib/ wird NICHT gescannt und GGML_BACKEND_PATH ist
# kein Suchverzeichnis. Plugins in lib/ = Summarization auf Endnutzer-Macs tot.
if ! ls "$LLAMA_BIN_DIR/"libggml-cpu-apple_*.so >/dev/null 2>&1; then
  echo "FAIL [llama]: no libggml-cpu-apple_*.so backend plugin in $LLAMA_BIN_DIR/ (neben der Executable!)" >&2
  FAIL=1
else
  echo "ok   [llama]: libggml-cpu-apple_*.so plugin present in bin/ ($(ls "$LLAMA_BIN_DIR/"libggml-cpu-apple_*.so | wc -l | tr -d ' ') variant(s))"
fi
check_no_homebrew_refs 'llama bundle' \
  "$LLAMA_BIN" \
  "$LLAMA_LIB/"*.dylib \
  "$LLAMA_BIN_DIR/"*.so

# Duplicate-variant guard: Homebrew ships each dylib under three names; only
# the single-major install names (lib*.N.dylib) are ever loaded. setup-llama.sh
# prunes the rest — fail if a re-run regressed that (~16 MB dead weight).
dupes=$(ls "$LLAMA_LIB"/lib{llama,llama-common,mtmd,ggml,ggml-base}.dylib \
  "$LLAMA_LIB"/lib*.*.*.*.dylib 2>/dev/null || true)
if [ -n "$dupes" ]; then
  echo "FAIL [llama]: unreferenced dylib name variants present (re-run setup-llama.sh):" >&2
  echo "$dupes" >&2
  FAIL=1
else
  echo "ok   [llama]: no duplicate dylib name variants"
fi

# Every @rpath reference in the llama bundle must resolve to a shipped file.
unresolved="$(
  for macho in "$LLAMA_BIN" "$LLAMA_LIB"/*.dylib "$LLAMA_BIN_DIR"/*.so; do
    otool -L "$macho" 2>/dev/null | awk -v self="$(basename "$macho")" \
      '$1 ~ /^@rpath\// { sub(/^@rpath\//, "", $1); if ($1 != self) print $1 }'
  done | sort -u | while read -r dep; do
    if [ ! -f "$LLAMA_LIB/$dep" ]; then echo "$dep"; fi
  done
)"
if [ -n "$unresolved" ]; then
  echo "FAIL [llama]: @rpath references without a bundled file:" >&2
  echo "$unresolved" >&2
  FAIL=1
else
  echo "ok   [llama]: all @rpath references resolve inside the bundle"
fi

check_rpaths_relative 'whisper rpaths' "$WHISPER_BIN" "$WHISPER_LIB/"*.dylib
check_rpaths_relative 'llama rpaths'   "$LLAMA_BIN" "$LLAMA_LIB/"*.dylib "$LLAMA_BIN_DIR/"*.so

echo ""
echo "=== vision-ocr ==="
if [ -f "$VISION_OCR" ]; then
  check_no_homebrew_refs 'vision-ocr' "$VISION_OCR"
  check_rpaths_relative  'vision-ocr rpaths' "$VISION_OCR"
else
  echo "skip [vision-ocr]: $VISION_OCR not built"
fi

echo ""
echo "=== python sidecar ==="
if [ -d "$SIDECAR" ]; then
  SP="$SIDECAR/lib/python3.12/site-packages"
  check_file_present 'torch_shm_manager' "$SP/torch/bin/torch_shm_manager"
  for pruned in "$SP/torch/include" "$SP/pip" "$SP/setuptools"; do
    if [ -d "$pruned" ]; then
      echo "FAIL [sidecar]: build-time-only dir shipped: $pruned (re-run build-sidecar.sh)" >&2
      FAIL=1
    fi
  done
  pyc_dirs=$(find "$SIDECAR" -type d -name '__pycache__' -print -quit)
  if [ -n "$pyc_dirs" ]; then
    echo "FAIL [sidecar]: __pycache__ present (unpruned build): $pyc_dirs" >&2
    FAIL=1
  else
    echo "ok   [sidecar]: pruned (no __pycache__, no torch/include, no pip/setuptools)"
  fi

  # Mach-O-Scan über alle Sidecar-Binaries (~350 Dateien, gebatcht via xargs):
  # LC_LOAD-Refs auf /opt/homebrew oder /Users = harter Fehler (dyld würde auf
  # Endnutzer-Macs ins Leere laufen bzw. auf dem Dev-Mac still Homebrew laden).
  # LC_ID-Einträge mit solchen Pfaden sind nur die Eigenkennung der Dylib —
  # harmlos solange nichts sie über diesen Pfad LÄDT, darum Warning.
  macho_scan=$( (find "$SIDECAR" -type f \( -name '*.dylib' -o -name '*.so' \) -print0; printf '%s\0' "$SIDECAR/bin/python3") \
    | xargs -0 otool -l 2>/dev/null | awk '
      /^\// && /:$/ { file=$0; sub(/:$/, "", file); next }
      $1 == "cmd" { cmd=$2; next }
      $1 == "name" && (cmd == "LC_LOAD_DYLIB" || cmd == "LC_LOAD_WEAK_DYLIB" || cmd == "LC_REEXPORT_DYLIB") \
        && ($2 ~ /^\/opt\/homebrew/ || $2 ~ /^\/Users\//) { print "LOAD\t" file "\t" $2 }
      $1 == "name" && cmd == "LC_ID_DYLIB" \
        && ($2 ~ /^\/opt\/homebrew/ || $2 ~ /^\/Users\//) { print "ID\t" file "\t" $2 }
    ')
  bad_loads=$(printf '%s\n' "$macho_scan" | grep '^LOAD' || true)
  id_warns=$(printf '%s\n' "$macho_scan" | grep '^ID' || true)
  if [ -n "$bad_loads" ]; then
    echo "FAIL [sidecar]: LC_LOAD references to /opt/homebrew or /Users (broken on end-user Macs):" >&2
    echo "$bad_loads" >&2
    FAIL=1
  else
    echo "ok   [sidecar]: no LC_LOAD references to /opt/homebrew or /Users"
  fi
  if [ -n "$id_warns" ]; then
    echo "warn [sidecar]: LC_ID_DYLIB with absolute dev path (harmless unless loaded by that path):"
    echo "$id_warns"
  fi
else
  echo "skip [sidecar]: $SIDECAR not built"
fi

# asar hygiene: only meaningful after `npm run package`. The old blacklist
# leaked swift_cli/.build (271 MB), website/ and the .env (R2 credentials!)
# into the shipped archive — never again.
#
# WICHTIG — Grenze dieses Checks: hier stehen nur SECRET-/BALLAST-Leaks
# (Dinge, die NICHT ins Archiv gehören). Eine Präsenzliste über Top-Level-
# Ordner kann NICHT prüfen, ob jede Runtime-Dependency auflösbar ist — genau
# daran ist der PDF-Import gestorben (fehlendes @napi-rs/canvas ⇒ pdfjs nicht
# importierbar), während dieser Check grün war. Diese Eigenschaft prüft
# `scripts/verify-asar-resolves.mjs` (wird unten aufgerufen). Absichtlich
# NICHT auf der forbidden-Liste: @napi-rs — ob es fehlen DARF, entscheidet
# das Resolve-Gate samt dokumentierter Allowlist, nicht ein Pfad-Verbot hier.
echo ""
echo "=== app.asar (if packaged) ==="
if [ -f "$ASAR" ]; then
  asar_list="$(npx --yes @electron/asar list "$ASAR" 2>/dev/null)"
  ASAR_FAIL=0
  # Herestrings statt `echo | grep -q`: grep -q beendet beim ersten Match und
  # schickt echo unter pipefail ein SIGPIPE — der Check würde flaky failen.
  for forbidden in '/swift_cli' '/.env' '/website' '/src'; do
    if grep -q "^$forbidden" <<<"$asar_list"; then
      echo "FAIL [asar]: forbidden path in app.asar: $forbidden" >&2
      ASAR_FAIL=1
    fi
  done
  for required in '/out/main/index.js' '/package.json' '/node_modules/better-sqlite3' '/node_modules/pdfjs-dist' '/node_modules/zod'; do
    if ! grep -q "^$required" <<<"$asar_list"; then
      echo "FAIL [asar]: required path missing from app.asar: $required" >&2
      ASAR_FAIL=1
    fi
  done
  if [ $ASAR_FAIL -eq 0 ]; then
    echo "ok   [asar]: no secret/ballast leaks, all top-level runtime deps present"
  else
    FAIL=1
  fi

  # Der eigentliche Beweis: löst jeder Runtime-Specifier im Bundle auf?
  echo ""
  echo "=== asar resolve gate ==="
  if node "$SCRIPT_DIR/verify-asar-resolves.mjs" "$ASAR"; then
    :
  else
    FAIL=1
  fi
else
  echo "skip [asar]: not packaged yet"
fi

echo ""
if [ $FAIL -ne 0 ]; then
  echo "VERIFY FAILED — mindestens ein Bundle-Check rot (Details oben). Das DMG würde auf Endnutzer-Macs fehlerhaft laufen." >&2
  exit 1
fi
echo "VERIFY OK — bundles are self-contained."

# Runtime-Smoke: führt die gebundelten Tools in einer Homebrew-freien Sandbox
# tatsächlich AUS (der ggml-Plugin-dlopen ist statisch unsichtbar — otool kann
# ihn nicht prüfen, nur ein echter Backend-Load).
if [ "$RUN_SMOKE" = true ]; then
  echo ""
  echo "=== runtime smoke (sandboxed) ==="
  if [ -n "$APP_PATH" ]; then
    "$SCRIPT_DIR/smoke-packaged.sh" --app "$APP_PATH"
  else
    "$SCRIPT_DIR/smoke-packaged.sh" --staging
  fi
fi
