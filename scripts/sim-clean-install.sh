#!/usr/bin/env bash
# sim-clean-install.sh — Simulate clean / upgrade / partial-reset installs
# Renames data directories instead of deleting so you can always restore.
#
# --launch-clean startet die installierte App zusätzlich in einer sandbox-exec-
# Umgebung, die /opt/homebrew und die maskierenden Dev-Caches (~/.flair,
# ~/.cache/huggingface, ~/.cache/torch) wegblendet — die App verhält sich wie
# auf einem Mac, der NUR das DMG hat. Nichts wird dabei verschoben/gelöscht.
set -euo pipefail

DATA_DIR="$HOME/.therascript"
SETTINGS_DIR="$HOME/Library/Application Support/therascript"
APP_PATH="/Applications/Therascript.app"

DATA_BAK="$DATA_DIR.bak"
SETTINGS_BAK="$SETTINGS_DIR.bak"
MODELS_DIR="$DATA_DIR/models"
MODELS_BAK="$MODELS_DIR.bak"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

require_app_closed() {
  if pgrep -f "Therascript.app" >/dev/null 2>&1; then
    red "TheraScript läuft noch — bitte beenden und nochmal starten."
    exit 1
  fi
}

abort_if_backup_exists() {
  local path="$1"
  if [ -e "$path" ]; then
    red "Backup-Pfad existiert bereits: $path"
    red "  Räume zuerst auf (siehe --restore) oder lösche das alte Backup manuell."
    exit 1
  fi
}

scenario_a_fresh() {
  bold "Szenario A — Brand-neu (FirstLaunchScreen + voller Modell-Download)"
  abort_if_backup_exists "$DATA_BAK"
  abort_if_backup_exists "$SETTINGS_BAK"

  if [ -d "$DATA_DIR" ]; then
    blue "→ verschiebe $DATA_DIR → $DATA_BAK"
    mv "$DATA_DIR" "$DATA_BAK"
  fi
  if [ -d "$SETTINGS_DIR" ]; then
    blue "→ verschiebe Settings → ${SETTINGS_DIR}.bak"
    mv "$SETTINGS_DIR" "$SETTINGS_BAK"
  fi
  if [ -d "$APP_PATH" ]; then
    if ls "$HOME/.Trash/" 2>/dev/null | grep -q '^Therascript-.*\.app$'; then
      red "  Hinweis: in ~/.Trash liegt bereits eine ältere Therascript-*.app —"
      red "  räume sie ggf. auf, bevor der Papierkorb voll läuft."
    fi
    blue "→ App nach Papierkorb (~/.Trash/Therascript-<timestamp>.app)"
    mv "$APP_PATH" "$HOME/.Trash/Therascript-$(date +%Y%m%d-%H%M%S).app"
  fi

  green "Bereit. Mounte jetzt das DMG und ziehe TheraScript in /Applications:"
  echo "  open ~/Downloads/Therascript.dmg"
  echo
  blue "Restore danach: $0 --restore"
}

scenario_b_upgrade() {
  bold "Szenario B — Update v0.7.1 → neu (Daten + Modelle bleiben)"
  if [ -d "$APP_PATH" ]; then
    blue "→ alte App nach Papierkorb"
    mv "$APP_PATH" "$HOME/.Trash/Therascript-$(date +%Y%m%d-%H%M%S).app"
  fi
  green "Bereit. Mounte das neue DMG und ziehe es in /Applications."
  echo "  open ~/Downloads/Therascript.dmg"
}

scenario_c_models_only() {
  bold "Szenario C — Nur Modelle erneut laden (Sessions + Settings bleiben)"
  abort_if_backup_exists "$MODELS_BAK"

  if [ -d "$MODELS_DIR" ]; then
    blue "→ verschiebe $MODELS_DIR → $MODELS_BAK"
    mv "$MODELS_DIR" "$MODELS_BAK"
  elif [ ! -d "$DATA_DIR" ] && [ -d "$DATA_BAK" ]; then
    red "Daten-Verzeichnis fehlt komplett — vermutlich läuft Szenario A."
    red "  Modelle sind unter $DATA_BAK/models gesichert. Erst $0 --restore."
    exit 0
  else
    red "Keine Modelle gefunden unter $MODELS_DIR — nichts zu tun."
    exit 0
  fi
  green "Bereit. Starte TheraScript — der FirstLaunchScreen lädt die Modelle neu."
  blue "Restore danach: $0 --restore"
}

# Restore-Philosophie: rename-only, nie löschen. Vom Testlauf frisch erzeugte
# Live-Verzeichnisse werden als <pfad>.testrun-<timestamp> geparkt (in --status
# sichtbar), damit --restore auch NACH einem App-Launch durchläuft.
restore() {
  # Live-Verzeichnisse werden verschoben — bei laufender App würde die offene
  # SQLite-DB per fd in die geparkte Kopie weiterschreiben, während pfadbasierte
  # Writes ins restaurierte Verzeichnis gehen (Split-Brain).
  require_app_closed
  bold "Restore — stelle Backups wieder her"
  local did_anything=0
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)

  park_and_restore() {
    local bak="$1" live="$2" label="$3"
    if [ ! -d "$bak" ]; then return 0; fi
    if [ -e "$live" ]; then
      blue "→ parke Testlauf-$label: $live → $live.testrun-$stamp"
      mv "$live" "$live.testrun-$stamp"
    fi
    blue "→ $bak → $live"
    mv "$bak" "$live"
    did_anything=1
  }

  # Reihenfolge: DATA vor MODELS — läuft Szenario A, liegt models.bak (falls
  # vorhanden) INNERHALB von DATA_BAK und kommt mit dem DATA-Restore zurück.
  park_and_restore "$DATA_BAK"     "$DATA_DIR"     "Daten"
  park_and_restore "$MODELS_BAK"   "$MODELS_DIR"   "Modelle"
  park_and_restore "$SETTINGS_BAK" "$SETTINGS_DIR" "Settings"

  if [ "$did_anything" -eq 0 ]; then
    green "Nichts zum Wiederherstellen gefunden."
  else
    green "Restore abgeschlossen."
    if ls -d "$DATA_DIR".testrun-* "$SETTINGS_DIR".testrun-* "$MODELS_DIR".testrun-* >/dev/null 2>&1; then
      blue "Geparkte Testlauf-Verzeichnisse (manuell löschen, wenn nicht mehr gebraucht):"
      ls -d "$DATA_DIR".testrun-* "$SETTINGS_DIR".testrun-* "$MODELS_DIR".testrun-* 2>/dev/null || true
    fi
  fi
}

# Startet die installierte App wie auf einem Endnutzer-Mac:
#  - sandbox-exec blendet /opt/homebrew + HF-/flair-/torch-Caches aus
#    (deny file-read*); deny file-write* auf die Caches fängt zusätzlich den
#    inversen Fehler (App legt still Caches ausserhalb ~/.therascript an).
#  - env -i ersetzt die Dev-Shell-Umgebung durch die launchd-Minimal-Env.
# Direkter Binary-Exec statt `open`, weil `open` die App ausserhalb der
# Sandbox spawnen würde. Beenden mit Cmd-Q in der App oder Ctrl-C hier.
launch_clean() {
  if [ ! -d "$APP_PATH" ]; then
    red "Keine App unter $APP_PATH — zuerst das DMG installieren."
    red "  Danach: $0 --launch-clean"
    exit 1
  fi
  require_app_closed

  local profile
  profile="$(mktemp -t therascript-clean-launch).sb"
  cat > "$profile" <<EOF
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

  bold "Clean-Launch — App startet OHNE /opt/homebrew und ohne Dev-Caches"
  blue "  Sandbox-Profil: $profile"
  blue "  Beenden: Cmd-Q in der App (oder Ctrl-C hier)"
  echo

  sandbox-exec -f "$profile" env -i \
    HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
    TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    __CF_USER_TEXT_ENCODING="$(id -u):0:0" \
    "$APP_PATH/Contents/MacOS/Therascript"
}

status() {
  bold "Aktueller Test-State"
  echo

  local mark_ok="\033[0;32m✓\033[0m"
  local mark_no="\033[0;31m✗\033[0m"
  local mark_bak="\033[0;33m●\033[0m"

  print_row() {
    local label="$1" path="$2"
    if [ -d "$path" ]; then
      printf "  $mark_ok  %-22s %s\n" "$label" "$path"
    else
      printf "  $mark_no  %-22s %s (fehlt)\n" "$label" "$path"
    fi
  }
  print_bak_row() {
    local label="$1" path="$2"
    if [ -d "$path" ]; then
      printf "  $mark_bak  %-22s %s (Backup vorhanden)\n" "$label" "$path"
    fi
  }

  print_row     "Daten"        "$DATA_DIR"
  print_bak_row "Daten-Backup" "$DATA_BAK"
  print_row     "Modelle"      "$MODELS_DIR"
  print_bak_row "Modell-Backup" "$MODELS_BAK"
  print_row     "Settings"     "$SETTINGS_DIR"
  print_bak_row "Settings-Backup" "$SETTINGS_BAK"
  print_row     "App"          "$APP_PATH"

  local trash_count
  trash_count=$(ls "$HOME/.Trash/" 2>/dev/null | grep -c '^Therascript-.*\.app$' || true)
  if [ "$trash_count" -gt 0 ]; then
    printf "  $mark_bak  %-22s %d App-Kopie(n)\n" "Papierkorb" "$trash_count"
  fi

  local testruns
  testruns=$(ls -d "$DATA_DIR".testrun-* "$SETTINGS_DIR".testrun-* "$MODELS_DIR".testrun-* 2>/dev/null || true)
  if [ -n "$testruns" ]; then
    echo
    blue "Geparkte Testlauf-Verzeichnisse (von --restore, manuell löschbar):"
    printf '%s\n' "$testruns" | while read -r t; do
      printf "  $mark_bak  %s\n" "$t"
    done
  fi

  echo
  if [ -d "$DATA_BAK" ] || [ -d "$MODELS_BAK" ] || [ -d "$SETTINGS_BAK" ]; then
    blue "Aktive Backups vorhanden — restore mit: $0 --restore"
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/sim-clean-install.sh [A|B|C] [--launch-clean] [--status | --restore | --help]

Szenario als Argument (nicht-interaktiv) oder ohne Argument interaktiv:
  A — Brand-neu (FirstLaunchScreen + voller ~4.1 GB Modell-Download)
  B — Update v0.7.x → neu (Daten + Modelle bleiben, nur App wird ersetzt)
  C — Nur Modelle neu (Sessions + Settings bleiben)

--launch-clean:  startet /Applications/Therascript.app in einer Sandbox ohne
                 /opt/homebrew und ohne ~/.flair, ~/.cache/huggingface,
                 ~/.cache/torch, mit launchd-Minimal-Env — verhält sich wie
                 auf einem Mac, der nur das DMG hat. Kombinierbar mit einem
                 Szenario (nach Szenario A/B zuerst das DMG installieren).
--status:        zeigt aktuellen Backup- und Install-State an.
--restore:       stellt alle .bak-Verzeichnisse wieder her; vom Test erzeugte
                 Live-Verzeichnisse werden als *.testrun-<timestamp> geparkt.

Beispiele:
  scripts/sim-clean-install.sh A                  # Zustand "frischer Mac" herstellen
  scripts/sim-clean-install.sh --launch-clean     # installierte App clean starten
  scripts/sim-clean-install.sh A --launch-clean   # beides (DMG-Install dazwischen manuell)
  scripts/sim-clean-install.sh --restore          # alles zurück
EOF
}

SCENARIO=""
LAUNCH_CLEAN=false
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --status) status; exit 0 ;;
    --restore) restore; exit 0 ;;
    --launch-clean) LAUNCH_CLEAN=true ;;
    [AaBbCc])
      # tr instead of ${1^^} — uppercase parameter expansion is bash 4+,
      # but stock macOS ships bash 3.2.
      SCENARIO=$(printf '%s' "$1" | tr 'a-z' 'A-Z')
      ;;
    *) usage; exit 1 ;;
  esac
  shift
done

if [ -z "$SCENARIO" ] && [ "$LAUNCH_CLEAN" = false ]; then
  require_app_closed
  bold "TheraScript Clean-Install Simulation"
  echo
  echo "  A) Brand-neu (FirstLaunchScreen + ~4.1 GB Modell-Download)"
  echo "  B) Update-Szenario (Daten bleiben, App wird ersetzt)"
  echo "  C) Nur Modelle löschen + neu laden"
  echo
  read -rp "Auswahl [A/B/C]: " choice
  echo
  SCENARIO=$(printf '%s' "$choice" | tr 'a-z' 'A-Z')
fi

if [ -n "$SCENARIO" ]; then
  require_app_closed
  case "$SCENARIO" in
    A) scenario_a_fresh ;;
    B) scenario_b_upgrade ;;
    C) scenario_c_models_only ;;
    *) red "Ungültige Auswahl."; exit 1 ;;
  esac
fi

if [ "$LAUNCH_CLEAN" = true ]; then
  echo
  if [ -d "$APP_PATH" ]; then
    launch_clean
  else
    blue "App noch nicht installiert — nach dem DMG-Install starten mit:"
    blue "  $0 --launch-clean"
  fi
fi
