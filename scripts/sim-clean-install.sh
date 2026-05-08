#!/usr/bin/env bash
# sim-clean-install.sh — Simulate clean / upgrade / partial-reset installs
# Renames data directories instead of deleting so you can always restore.
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

restore() {
  bold "Restore — stelle Backups wieder her"
  local did_anything=0

  if [ -d "$MODELS_BAK" ]; then
    if [ -d "$MODELS_DIR" ]; then
      red "  $MODELS_DIR existiert bereits — überspringe (manuell prüfen)"
    else
      blue "→ $MODELS_BAK → $MODELS_DIR"
      mv "$MODELS_BAK" "$MODELS_DIR"
      did_anything=1
    fi
  fi

  if [ -d "$DATA_BAK" ]; then
    if [ -d "$DATA_DIR" ]; then
      red "  $DATA_DIR existiert bereits (frisch erzeugt vom Test)."
      red "  Verschiebe es manuell weg, dann nochmal: $0 --restore"
    else
      blue "→ $DATA_BAK → $DATA_DIR"
      mv "$DATA_BAK" "$DATA_DIR"
      did_anything=1
    fi
  fi

  if [ -d "$SETTINGS_BAK" ]; then
    if [ -d "$SETTINGS_DIR" ]; then
      red "  Settings-Verzeichnis existiert bereits (frisch erzeugt)."
      red "  Manuell prüfen, dann nochmal: $0 --restore"
    else
      blue "→ $SETTINGS_BAK → $SETTINGS_DIR"
      mv "$SETTINGS_BAK" "$SETTINGS_DIR"
      did_anything=1
    fi
  fi

  if [ "$did_anything" -eq 0 ]; then
    green "Nichts zum Wiederherstellen gefunden."
  else
    green "Restore abgeschlossen."
  fi
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

  echo
  if [ -d "$DATA_BAK" ] || [ -d "$MODELS_BAK" ] || [ -d "$SETTINGS_BAK" ]; then
    blue "Aktive Backups vorhanden — restore mit: $0 --restore"
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/sim-clean-install.sh [--status | --restore | --help]

Ohne Argument: interaktive Auswahl A/B/C
  A — Brand-neu (FirstLaunchScreen + voller ~4.1 GB Modell-Download)
  B — Update v0.7.x → neu (Daten + Modelle bleiben, nur App wird ersetzt)
  C — Nur Modelle neu (Sessions + Settings bleiben)

Mit --status:  zeigt aktuellen Backup- und Install-State an.
Mit --restore: stellt alle .bak-Verzeichnisse wieder her.
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --status) status; exit 0 ;;
  --restore) restore; exit 0 ;;
  '')
    require_app_closed
    bold "TheraScript Clean-Install Simulation"
    echo
    echo "  A) Brand-neu (FirstLaunchScreen + ~4.1 GB Modell-Download)"
    echo "  B) Update-Szenario (Daten bleiben, App wird ersetzt)"
    echo "  C) Nur Modelle löschen + neu laden"
    echo
    read -rp "Auswahl [A/B/C]: " choice
    echo
    # tr instead of ${choice^^} — uppercase parameter expansion is bash 4+,
    # but stock macOS ships bash 3.2.
    choice_upper=$(printf '%s' "$choice" | tr 'a-z' 'A-Z')
    case "$choice_upper" in
      A) scenario_a_fresh ;;
      B) scenario_b_upgrade ;;
      C) scenario_c_models_only ;;
      *) red "Ungültige Auswahl."; exit 1 ;;
    esac
    ;;
  *) usage; exit 1 ;;
esac
