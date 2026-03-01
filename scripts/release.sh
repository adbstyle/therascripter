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

# ── Version selection ────────────────────────────────────────────────────────

CURRENT="$(current_version)"
NEXT_PATCH="$(bump_patch "$CURRENT")"
NEXT_MINOR="$(bump_minor "$CURRENT")"
NEXT_MAJOR="$(bump_major "$CURRENT")"

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

# ── Release notes ────────────────────────────────────────────────────────────

echo ""
echo "  Release Notes (optional, Eingabe leer lassen zum Überspringen):"
read -rp "  > " RELEASE_NOTES

# ── Version bump ─────────────────────────────────────────────────────────────

echo ""
echo "→ Setze Version auf $NEW_VERSION in package.json …"
set_version "$NEW_VERSION"

# ── Git commit + tag ─────────────────────────────────────────────────────────

cd "$ROOT_DIR"

echo "→ Git commit + tag v$NEW_VERSION …"
git add package.json

# Only commit if package.json actually changed
if git diff --cached --quiet; then
  echo "  (keine Änderung in package.json — überspringe commit)"
else
  git commit -m "chore: bump version to $NEW_VERSION"
fi

# Only create tag if it doesn't exist yet
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
  echo "  (Tag v$NEW_VERSION existiert bereits — überspringe)"
else
  git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
fi

echo "→ Push commit + tag …"
git push origin HEAD
git push origin "v$NEW_VERSION"

# ── Build DMG ────────────────────────────────────────────────────────────────

echo ""
echo "→ Baue DMG (npm run package) …"
cd "$ROOT_DIR"
npm run package electron-builder.yml

# ── Locate DMG ───────────────────────────────────────────────────────────────

DMG_PATH="$ROOT_DIR/dist/Therascript-$NEW_VERSION-arm64.dmg"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "❌ DMG nicht gefunden: $DMG_PATH"
  exit 1
fi

echo "  DMG: $DMG_PATH"

# ── GitHub Release ───────────────────────────────────────────────────────────

echo ""
echo "→ Erstelle GitHub Release v$NEW_VERSION …"

GH_ARGS=(
  release create "v$NEW_VERSION"
  --title "Therascript v$NEW_VERSION"
  "$DMG_PATH"
)

if [[ -n "$RELEASE_NOTES" ]]; then
  GH_ARGS+=(--notes "$RELEASE_NOTES")
else
  GH_ARGS+=(--generate-notes)
fi

gh "${GH_ARGS[@]}"

echo ""
echo "✅ Release v$NEW_VERSION erfolgreich erstellt!"
echo "   https://github.com/adbstyle/therascripter/releases/tag/v$NEW_VERSION"
echo ""
