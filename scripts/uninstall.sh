#!/usr/bin/env bash
# Therascript Deinstallations-Script
# Löscht alle App-Daten: Modelle (~4 GB), Datenbank, PDFs und Aufnahmen.
# Die App selbst (/Applications/Therascript.app) muss manuell in den Papierkorb gezogen werden.
set -euo pipefail

APP_DATA="$HOME/.therascript"

echo "=== Therascript Deinstallation ==="
echo ""

# Prüfen ob Daten vorhanden sind
if [ ! -d "$APP_DATA" ]; then
  echo "Keine App-Daten gefunden ($APP_DATA)."
  echo "Therascript ist bereits deinstalliert oder wurde nie gestartet."
  exit 0
fi

# Übersicht was gelöscht wird
echo "Folgende Daten werden gelöscht:"
echo ""
echo "  $APP_DATA/"
du -sh "$APP_DATA" 2>/dev/null | awk '{print "  Grösse: " $1}'
echo ""
echo "  Enthält: Sprachmodelle, Datenbank, importierte PDFs, Audioaufnahmen"
echo ""

# Bestätigung
read -r -p "Wirklich löschen? [j/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[jJ]$ ]]; then
  echo "Abgebrochen."
  exit 0
fi

echo ""
echo "Lösche $APP_DATA ..."
rm -rf "$APP_DATA"
echo "  -> Gelöscht."

echo ""
echo "=== Fertig ==="
echo ""
echo "Die App selbst kann jetzt in den Papierkorb gezogen werden:"
echo "  /Applications/Therascript.app"
