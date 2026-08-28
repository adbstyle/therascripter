#!/usr/bin/env bash
# release.sh — Therascript Release Script
# Bumps version, builds DMG, creates GitHub release
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_JSON="$ROOT_DIR/package.json"
# Wird an JEDE Release-Note angehängt (Endanwender-Anleitung, siehe Datei-Header).
INSTALL_GUIDE_FILE="$ROOT_DIR/scripts/release-install-guide.md"

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

validate_version() {
  if ! [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ Ungültiges Versionsformat: '$1' — erwartet: X.Y.Z"
    exit 1
  fi
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
Mit --bump oder --version: nicht-interaktiv, keine Rückfragen; läuft nur auf
dem main-Branch (Ersatz für die entfallene menschliche Bestätigung).
Notes aus --notes/--notes-file; fehlen sie, werden sie von GitHub aus den
Commits generiert. Die Installationsanleitung für Endanwender
(scripts/release-install-guide.md) wird IMMER automatisch angehängt.
EOF
}

BUMP=""
VERSION_ARG=""
NOTES_ARG=""
NOTES_FILE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bump|--version|--notes|--notes-file)
      if [ $# -lt 2 ]; then
        echo "❌ Option $1 braucht einen Wert."
        usage
        exit 1
      fi
      case "$1" in
        --bump)       BUMP="$2" ;;
        --version)    VERSION_ARG="$2" ;;
        --notes)      NOTES_ARG="$2" ;;
        --notes-file) NOTES_FILE_ARG="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unbekannte Option: $1"; usage; exit 1 ;;
  esac
done

# ── Fail-fast: ALLE Flag-Inputs validieren, bevor irgendetwas passiert ──────
# (Build dauert >10 min und pusht Commit+Tag — ein Tippfehler in einem Flag
# darf nicht erst danach auffallen.)

if [ -n "$BUMP" ] && [ -n "$VERSION_ARG" ]; then
  echo "❌ --bump und --version schliessen sich gegenseitig aus."
  exit 1
fi
if [ -n "$BUMP" ]; then
  case "$BUMP" in
    patch|minor|major) ;;
    *) echo "❌ --bump erwartet patch|minor|major (war: $BUMP)"; exit 1 ;;
  esac
fi
if [ -n "$VERSION_ARG" ]; then
  validate_version "$VERSION_ARG"
fi
if [ -n "$NOTES_ARG" ] && [ -n "$NOTES_FILE_ARG" ]; then
  echo "❌ --notes und --notes-file schliessen sich gegenseitig aus."
  exit 1
fi

# Notes-Quelle sofort auflösen — ab hier gibt es nur noch NOTES_BODY.
NOTES_BODY=""
if [ -n "$NOTES_FILE_ARG" ]; then
  if [ ! -f "$NOTES_FILE_ARG" ]; then
    echo "❌ --notes-file nicht gefunden: $NOTES_FILE_ARG"
    exit 1
  fi
  NOTES_BODY="$(cat "$NOTES_FILE_ARG")"
elif [ -n "$NOTES_ARG" ]; then
  NOTES_BODY="$NOTES_ARG"
fi

if [ ! -f "$INSTALL_GUIDE_FILE" ]; then
  echo "❌ Installationsanleitung fehlt: $INSTALL_GUIDE_FILE"
  exit 1
fi

INTERACTIVE=true
if [ -n "$BUMP" ] || [ -n "$VERSION_ARG" ]; then
  INTERACTIVE=false
  # Branch-Guard: interaktiv fängt der Mensch am Bestätigungs-Prompt einen
  # falschen Branch ab — nicht-interaktiv muss das Skript es tun. Ein Release
  # von einem Feature-Branch würde dessen HEAD pushen und ungemergten Code
  # öffentlich veröffentlichen.
  CURRENT_BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
  if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "❌ Nicht-interaktives Release nur vom main-Branch (aktuell: $CURRENT_BRANCH)."
    exit 1
  fi
fi

# ── Version selection ────────────────────────────────────────────────────────

CURRENT="$(current_version)"
NEXT_PATCH="$(bump_patch "$CURRENT")"
NEXT_MINOR="$(bump_minor "$CURRENT")"
NEXT_MAJOR="$(bump_major "$CURRENT")"

# Der interaktive Modus FÜLLT nur BUMP/VERSION_ARG — die Auflösung zu
# NEW_VERSION teilt er sich danach mit dem Flag-Pfad (eine Implementierung,
# eine Validierung).
if [ "$INTERACTIVE" = true ]; then
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
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    4) read -rp "  Version eingeben (z.B. 1.2.3): " VERSION_ARG ;;
    *) echo "❌ Ungültige Auswahl."; exit 1 ;;
  esac
fi

if [ -n "$VERSION_ARG" ]; then
  validate_version "$VERSION_ARG"
  NEW_VERSION="$VERSION_ARG"
else
  case "$BUMP" in
    patch) NEW_VERSION="$NEXT_PATCH" ;;
    minor) NEW_VERSION="$NEXT_MINOR" ;;
    major) NEW_VERSION="$NEXT_MAJOR" ;;
  esac
fi

if [ "$INTERACTIVE" = true ]; then
  echo ""
  echo "  Neue Version: $NEW_VERSION"
  read -rp "  Fortfahren? [j/N] " confirm
  [[ "$confirm" =~ ^[jJyY]$ ]] || { echo "Abgebrochen."; exit 0; }

  if [ -z "$NOTES_BODY" ]; then
    echo ""
    echo "  Release Notes (optional, leer = von GitHub aus Commits generiert):"
    read -rp "  > " NOTES_BODY
  fi
else
  echo ""
  echo "Release (nicht-interaktiv): $CURRENT → $NEW_VERSION"
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
# Die Installationsanleitung (scripts/release-install-guide.md) wird IMMER an
# die Notes angehängt — die Anwender sind technisch nicht versiert und
# brauchen bei jedem Release die exakten Schritte. Der Guide liegt als eigene
# Markdown-Datei vor (editierbar ohne Shell-Quoting-Fallen); Fakten dort mit
# README.md synchron halten.

echo ""
echo "→ Erstelle GitHub Release v$NEW_VERSION …"

if [ -z "$NOTES_BODY" ]; then
  # Von GitHub aus den Commits generieren. Muss NACH dem Tag-Push laufen
  # (generate-notes referenziert den Tag). Kein --generate-notes-Flag möglich:
  # gh release create kann es nicht mit --notes-file kombinieren, und der
  # Guide muss angehängt werden. Fehler hier NICHT verschlucken — ein
  # changelog-loses Release soll laut auffallen, auch wenn wir es (mit Guide)
  # trotzdem veröffentlichen.
  if ! NOTES_BODY="$(gh api "repos/{owner}/{repo}/releases/generate-notes" \
      -f tag_name="v$NEW_VERSION" --jq .body)"; then
    NOTES_BODY=""
    echo "⚠️  GitHub-Notes-Generierung fehlgeschlagen — das Release enthält nur"
    echo "    die Installationsanleitung. Changelog nachtragen mit:"
    echo "    gh release edit v$NEW_VERSION --notes-file <datei>"
  fi
fi

NOTES_TMP="$(mktemp -t therascript-release-notes)"
trap 'rm -f "$NOTES_TMP"' EXIT
{
  if [ -n "$NOTES_BODY" ]; then
    printf '%s\n\n---\n\n' "$NOTES_BODY"
  fi
  cat "$INSTALL_GUIDE_FILE"
} > "$NOTES_TMP"

gh release create "v$NEW_VERSION" \
  --title "Therascript v$NEW_VERSION" \
  --notes-file "$NOTES_TMP" \
  "$DMG_PATH"

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
