#!/usr/bin/env bash
# Audits all references to legacy SessionStatus values that will be removed in Issue #80 Phase A.
# Run before and after Phase B to verify zero callsites remain (excluding migrations and tests).
# Uses grep (portable, no ripgrep dependency).
set -euo pipefail

cd "$(dirname "$0")/.."

PATTERN_LEGACY="(transcribing|diarizing|extracting|anonymizing)"

echo "=== Status-String-Vergleiche ==="
grep -rEn --include='*.ts' --include='*.tsx' "session\.status === '${PATTERN_LEGACY}'" src/ || echo "(keine Treffer)"

echo
echo "=== Status-Literale in Set-Statements ==="
grep -rEn --include='*.ts' --include='*.tsx' "status: '${PATTERN_LEGACY}'" src/ || echo "(keine Treffer)"

echo
echo "=== SessionStatus-Type-Member ==="
grep -En "'${PATTERN_LEGACY}'" src/shared/types/Session.ts || echo "(keine Treffer)"

echo
echo "=== Migration-Files (erwartet — nicht anpassen) ==="
grep -rEn "'${PATTERN_LEGACY}'" src/main/db/migrations/ || echo "(keine Treffer)"
