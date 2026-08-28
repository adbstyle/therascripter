#!/usr/bin/env bash
# release.sh — Therascript Release Script
# Bumps version, builds DMG, creates GitHub release
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_JSON="$ROOT_DIR/package.json"

# ── Helpers ─────────────────────────────────────────────────────────────────

current_version() {
  node -e "process.stdout.write(require('$PACKAGE_JSON').version)"
}

bump_patch() {
  local v="$1"
  IFS='.' read -r major minor patch <<< "$v"
  echo "$major.$minor.$((patch + 1))"
}

bump_minor() {
  local v="$1"
  IFS='.' read -r major minor _patch <<< "$v"
  echo "$major.$((minor + 1)).0"
}

bump_major() {
  local v="$1"
  IFS='.' read -r major _minor _patch <<< "$v"
  echo "$((major + 1)).0.0"
}

set_version() {
  local new_ver="$1"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PACKAGE_JSON', 'utf8'));
    pkg.version = '$new_ver';
    fs.writeFileSync('$PACKAGE_JSON', JSON.stringify(pkg, null, 2) + '\n');
  "
}

# ── CLI-Args (Hybrid-Modus) ─────────────────────────────────────────────────
# Ohne Argumente: interaktiv wie bisher. Mit --bump/--version: nicht-interaktiv
# (keine Rückfragen) — gedacht für automatisierte Releases, bei denen der
# Aufrufer (z. B. Claude) Versionsentscheid und Release Notes liefert.

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [--bump patch|minor|major | --version X.Y.Z]
                          [--notes "text" | --notes-file <pfad>]

Ohne Argumente: interaktiver Modus (Fragen wie bisher).
Mit --bump oder --version: nicht-interaktiv, keine Rückfragen.
Notes aus --notes/--notes-file; fehlen sie, werden sie von GitHub aus den
Commits generiert. Die Installationsanleitung für Endanwender wird IMMER
automatisch an die Release Notes angehängt.
EOF
}

BUMP=""
VERSION_ARG=""
NOTES_ARG=""
NOTES_FILE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bump)       BUMP="${2:-}"; shift 2 ;;
    --version)    VERSION_ARG="${2:-}"; shift 2 ;;
    --notes)      NOTES_ARG="${2:-}"; shift 2 ;;
    --notes-file) NOTES_FILE_ARG="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "❌ Unbekannte Option: $1"; usage; exit 1 ;;
  esac
done

INTERACTIVE=true
if [ -n "$BUMP" ] || [ -n "$VERSION_ARG" ]; then
  INTERACTIVE=false
fi

# ── Version selection ────────────────────────────────────────────────────────

CURRENT="$(current_version)"
NEXT_PATCH="$(bump_patch "$CURRENT")"
NEXT_MINOR="$(bump_minor "$CURRENT")"
NEXT_MAJOR="$(bump_major "$CURRENT")"

RELEASE_NOTES=""

if [ "$INTERACTIVE" = false ]; then
  if [ -n "$VERSION_ARG" ]; then
    if ! [[ "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "❌ Ungültiges Format für --version. Erwartet: X.Y.Z"
      exit 1
    fi
    NEW_VERSION="$VERSION_ARG"
  else
    case "$BUMP" in
      patch) NEW_VERSION="$NEXT_PATCH" ;;
      minor) NEW_VERSION="$NEXT_MINOR" ;;
      major) NEW_VERSION="$NEXT_MAJOR" ;;
      *) echo "❌ --bump erwartet patch|minor|major (war: $BUMP)"; exit 1 ;;
    esac
  fi
  echo ""
  echo "Release (nicht-interaktiv): $CURRENT → $NEW_VERSION"
else
  echo ""
  echo "╔══════════════════════════════════════════╗"
  echo "║        Therascript Release Script        ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "  Aktuelle Version: $CURRENT"
  echo ""
  echo "  Wähle neue Version:"
  echo "    1) Patch  → $NEXT_PATCH"
  echo "    2) Minor  → $NEXT_MINOR"
  echo "    3) Major  → $NEXT_MAJOR"
  echo "    4) Eigene Version eingeben"
  echo ""
  read -rp "  Auswahl [1-4]: " choice

  case "$choice" in
    1) NEW_VERSION="$NEXT_PATCH" ;;
    2) NEW_VERSION="$NEXT_MINOR" ;;
    3) NEW_VERSION="$NEXT_MAJOR" ;;
    4)
      read -rp "  Version eingeben (z.B. 1.2.3): " custom
      if ! [[ "$custom" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Ungültiges Format. Erwartet: X.Y.Z"
        exit 1
      fi
      NEW_VERSION="$custom"
      ;;
    *)
      echo "❌ Ungültige Auswahl."
      exit 1
      ;;
  esac

  echo ""
  echo "  Neue Version: $NEW_VERSION"
  read -rp "  Fortfahren? [j/N] " confirm
  [[ "$confirm" =~ ^[jJyY]$ ]] || { echo "Abgebrochen."; exit 0; }

  # Interaktive Notes nur, wenn nicht schon per Flag geliefert
  if [ -z "$NOTES_ARG" ] && [ -z "$NOTES_FILE_ARG" ]; then
    echo ""
    echo "  Release Notes (optional, Eingabe leer lassen zum Überspringen):"
    read -rp "  > " RELEASE_NOTES
  fi
fi

# ── Version bump ─────────────────────────────────────────────────────────────

echo ""
echo "→ Setze Version auf $NEW_VERSION in package.json …"
set_version "$NEW_VERSION"

# ── Git commit (nur lokal — Push erst NACH erfolgreichem Build + Verify) ────

cd "$ROOT_DIR"

echo "→ Git commit (lokal) …"
git add package.json

# Only commit if package.json actually changed
if git diff --cached --quiet; then
  echo "  (keine Änderung in package.json — überspringe commit)"
else
  git commit -m "chore: bump version to $NEW_VERSION"
fi

# ── Build DMG ────────────────────────────────────────────────────────────────

echo ""
echo "→ Baue DMG (npm run package) …"
cd "$ROOT_DIR"
npm run package electron-builder.yml

# ── Locate DMG ───────────────────────────────────────────────────────────────

DMG_PATH="$ROOT_DIR/dist/Therascript.dmg"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "❌ DMG nicht gefunden: $DMG_PATH"
  echo "   (Version-Commit ist nur lokal — mit 'git reset HEAD~1' rückgängig machbar.)"
  exit 1
fi

echo "  DMG: $DMG_PATH"

# ── Verify + Smoke (Release-Gate) ────────────────────────────────────────────
# Prüft die GEPACKTE .app: Bundles self-contained (statisch) + alle ML-Tools
# laufen in einer Homebrew-freien Sandbox (Runtime). Bei Rot hat noch nichts
# die Maschine verlassen — kein Tag, kein Push, kein Release.

echo ""
echo "→ Verifiziere Bundles + Runtime-Smoke …"
if ! "$ROOT_DIR/scripts/verify-bundles.sh" --app "$ROOT_DIR/dist/mac-arm64/Therascript.app" --smoke; then
  echo ""
  echo "❌ Verifikation fehlgeschlagen — Release abgebrochen."
  echo "   Nichts wurde gepusht. Fix committen (Version-Commit ggf. amenden) und erneut starten."
  exit 1
fi

# ── Git tag + push (erst jetzt — Build und Verify sind grün) ─────────────────

# Only create tag if it doesn't exist yet
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
  echo "  (Tag v$NEW_VERSION existiert bereits — überspringe)"
else
  git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
fi

echo "→ Push commit + tag …"
git push origin HEAD
git push origin "v$NEW_VERSION"

# ── GitHub Release ───────────────────────────────────────────────────────────
# Die Installationsanleitung wird IMMER an die Notes angehängt — die Anwender
# sind technisch nicht versiert und brauchen bei jedem Release die exakten
# Schritte (inkl. xattr -cr: Rechtsklick→Öffnen whitelistet nur den App-Start,
# nicht die inneren ML-Binaries — siehe CLAUDE.md Gotcha zu u+w/Quarantäne).

INSTALL_GUIDE=$(cat <<'GUIDE_EOF'
## 📦 Installationsanleitung

**Systemvoraussetzungen:** Mac mit Apple-Chip (M1–M4), macOS 26 (Tahoe) oder neuer, mindestens 8 GB Arbeitsspeicher, ca. 6 GB freier Speicherplatz. Für den ersten Start wird eine Internetverbindung benötigt (Modell-Download, ~4.1 GB) — danach arbeitet Therascript vollständig offline.

### Schritt 1: Herunterladen und installieren

1. Unten bei **Assets** auf `Therascript.dmg` klicken und die Datei herunterladen.
2. Die heruntergeladene Datei `Therascript.dmg` doppelklicken — ein Fenster öffnet sich.
3. Das Therascript-Symbol in den Ordner **Programme** ziehen.
4. Das Fenster schliessen.

### Schritt 2: App freigeben (einmalig, wichtig!)

macOS blockiert Apps, die nicht aus dem App Store stammen. Damit Therascript vollständig funktioniert, muss die App einmalig freigegeben werden:

1. **Terminal** öffnen: Tastenkombination `cmd + Leertaste` drücken, „Terminal" eintippen, mit `Enter` bestätigen.
2. Die folgende Zeile kopieren, im Terminal einfügen und `Enter` drücken:
   ```
   xattr -cr /Applications/Therascript.app
   ```
3. Das Terminal kann danach geschlossen werden.

> ⚠️ **Wichtig:** „Rechtsklick → Öffnen" allein genügt **nicht** — damit startet zwar die App, aber die eingebauten Verarbeitungs-Werkzeuge bleiben blockiert und die Transkription schlägt fehl. Bitte immer den Terminal-Befehl aus Schritt 2 verwenden.

### Schritt 3: Starten

1. Therascript aus dem Ordner **Programme** (oder über das Launchpad) starten.
2. Beim ersten Start lädt die App die benötigten Sprachmodelle herunter (~4.1 GB, je nach Internetverbindung 10–30 Minuten). Der Fortschritt wird angezeigt.
3. Fertig — ab jetzt arbeitet Therascript komplett lokal auf Ihrem Mac, ohne Cloud.

**Update von einer früheren Version:** Einfach Schritt 1 und 2 wiederholen (alte App im Programme-Ordner ersetzen). Ihre Transkriptionen, Einstellungen und die bereits heruntergeladenen Modelle bleiben erhalten.
GUIDE_EOF
)

echo ""
echo "→ Erstelle GitHub Release v$NEW_VERSION …"

NOTES_BODY=""
if [ -n "$NOTES_FILE_ARG" ]; then
  if [ ! -f "$NOTES_FILE_ARG" ]; then
    echo "❌ --notes-file nicht gefunden: $NOTES_FILE_ARG"
    exit 1
  fi
  NOTES_BODY="$(cat "$NOTES_FILE_ARG")"
elif [ -n "$NOTES_ARG" ]; then
  NOTES_BODY="$NOTES_ARG"
elif [ -n "$RELEASE_NOTES" ]; then
  NOTES_BODY="$RELEASE_NOTES"
else
  # Von GitHub aus den Commits generieren (Fallback: leer, Guide bleibt)
  NOTES_BODY="$(gh api "repos/{owner}/{repo}/releases/generate-notes" \
    -f tag_name="v$NEW_VERSION" --jq .body 2>/dev/null || true)"
fi

NOTES_TMP="$(mktemp -t therascript-release-notes).md"
{
  if [ -n "$NOTES_BODY" ]; then
    printf '%s\n\n---\n\n' "$NOTES_BODY"
  fi
  printf '%s\n' "$INSTALL_GUIDE"
} > "$NOTES_TMP"

gh release create "v$NEW_VERSION" \
  --title "Therascript v$NEW_VERSION" \
  --notes-file "$NOTES_TMP" \
  "$DMG_PATH"

rm -f "$NOTES_TMP"

# ── Update manifest ──────────────────────────────────────────────────────────

echo ""
echo "→ Aktualisiere manifest.json mit latestAppVersion=$NEW_VERSION …"
if ! "$ROOT_DIR/scripts/publish-manifest.sh" --app-version-only; then
  echo "⚠️  Manifest-Update fehlgeschlagen. Bitte manuell ausführen:"
  echo "   scripts/publish-manifest.sh --app-version-only"
fi

echo ""
echo "✅ Release v$NEW_VERSION erfolgreich erstellt!"
echo "   https://github.com/adbstyle/therascripter/releases/tag/v$NEW_VERSION"
echo ""
