# Shared helper: rewrite absolute /opt/homebrew Mach-O references to @rpath.
# Sourced by setup-whisper.sh and setup-llama.sh (war vorher in beiden
# Skripten verbatim dupliziert).
#
# Usage:  source "$(dirname "${BASH_SOURCE[0]}")/lib/rewrite-macho.sh"
#         rewrite_macho <path> <dylib|binary>
#
# MUSS vor dem ad-hoc-codesign-Schritt laufen — install_name_tool
# invalidiert die Mach-O-Signatur.

rewrite_macho() {
  local macho="$1"
  local kind="$2" # "dylib" or "binary"
  # Rewrite the dylib's own install name (LC_ID) so dyld dedups consistently
  # regardless of how the file was loaded.
  if [ "$kind" = 'dylib' ]; then
    install_name_tool -id "@rpath/$(basename "$macho")" "$macho"
  fi
  # Rewrite every absolute /opt/homebrew dependency (covers both
  # /opt/homebrew/opt/<formula>/lib/... and /opt/homebrew/Cellar/<formula>/<ver>/lib/...).
  otool -L "$macho" | awk '$1 ~ /^\/opt\/homebrew/ {print $1}' | while read -r dep; do
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$macho"
  done
}
