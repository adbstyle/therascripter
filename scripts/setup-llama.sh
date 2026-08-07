#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Bundle layout rationale: see docs/plans/ggml-abi-split.md. whisper.cpp and
# llama.cpp link against incompatible ggml generations, so each toolchain
# lives in its own self-contained dir; LC_RPATH=@loader_path/../lib in both
# binaries resolves to the tool-specific lib/ sibling.
BIN_DIR="$REPO_ROOT/resources/llama/bin"
LIB_DIR="$REPO_ROOT/resources/llama/lib"

# Migrations-Cleanup: remove the previous shared layout if upgrading from
# before docs/plans/ggml-abi-split.md. Only deletes llama's share of
# resources/lib (libllama*, libmtmd*, libggml*) and the old llama-cli binary
# — never touches whisper's bundle, ffmpeg, or vision-ocr.
rm -f \
  "$REPO_ROOT/resources/bin/llama-cli" \
  "$REPO_ROOT/resources/lib/"libllama*.dylib \
  "$REPO_ROOT/resources/lib/"libmtmd*.dylib \
  "$REPO_ROOT/resources/lib/"libggml*.dylib 2>/dev/null || true

# Gemma 4 E4B Q4_K_M GGUF was not yet published when this feature shipped — see
# CLAUDE.md ("Gemma 4 E4B GGUF source"). Fallback: Gemma 3 4B Instruct Q4_K_M.
# The repo is HuggingFace-gated → run `huggingface-cli login` before --model.
GGUF_FILENAME='google_gemma-3-4b-it-Q4_K_M.gguf'
GGUF_REPO='bartowski/google_gemma-3-4b-it-GGUF'
GGUF_URL="https://huggingface.co/${GGUF_REPO}/resolve/main/${GGUF_FILENAME}"

mkdir -p "$BIN_DIR" "$LIB_DIR"

echo '==> Installing llama.cpp via Homebrew'
if ! command -v brew >/dev/null 2>&1; then
  echo 'Homebrew is required. Install from https://brew.sh' >&2
  exit 1
fi
brew install llama.cpp

BREW_PREFIX="$(brew --prefix llama.cpp)"
echo '==> Copying llama-cli binary'
cp "$BREW_PREFIX/bin/llama-cli" "$BIN_DIR/llama-cli"

echo '==> Copying runtime dylibs'
# llama-cli (>= b8920) links against libllama, libllama-common and libmtmd
# from the llama.cpp formula plus libggml + libggml-base from the ggml
# formula (separate Homebrew install). Copy all of them.
cp "$BREW_PREFIX/lib/"libllama*.dylib "$LIB_DIR/" 2>/dev/null || true
cp "$BREW_PREFIX/lib/"libmtmd*.dylib "$LIB_DIR/" 2>/dev/null || true
GGML_PREFIX="$(brew --prefix ggml 2>/dev/null || true)"
if [ -n "$GGML_PREFIX" ] && [ -d "$GGML_PREFIX/lib" ]; then
  cp "$GGML_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true
fi
# Fallback: some older formulas ship libggml in the llama.cpp prefix.
cp "$BREW_PREFIX/lib/"libggml*.dylib "$LIB_DIR/" 2>/dev/null || true

# libllama-common transitively links libssl + libcrypto from Homebrew's
# openssl@3 — macOS no longer ships system OpenSSL, so we MUST bundle them.
# Without this the DMG fails on end-user Macs without Homebrew at the
# expected prefix.
echo '==> Copying OpenSSL dylibs (transitive dep of libllama-common)'
OPENSSL_PREFIX="$(brew --prefix openssl@3 2>/dev/null || true)"
if [ -z "$OPENSSL_PREFIX" ] || [ ! -d "$OPENSSL_PREFIX/lib" ]; then
  echo 'FATAL: openssl@3 not found via Homebrew. Run: brew install openssl@3' >&2
  exit 1
fi
cp "$OPENSSL_PREFIX/lib/libssl.3.dylib" "$LIB_DIR/"
cp "$OPENSSL_PREFIX/lib/libcrypto.3.dylib" "$LIB_DIR/"

# ggml 0.10+ uses a plugin architecture: backend implementations (Metal, BLAS,
# CPU variants) live as separate libggml-*.so files that libggml dlopens at
# runtime. libggml has a hardcoded fallback path
# (/opt/homebrew/Cellar/ggml/<ver>/libexec) AND respects $GGML_BACKEND_PATH —
# we bundle the .so files into resources/llama/lib/ and the main process sets
# GGML_BACKEND_PATH=<lib_dir> when spawning llama-cli (see LlamaSummarizer.ts).
echo '==> Copying ggml backend plugins (.so) for Apple Silicon'
if [ -z "$GGML_PREFIX" ] || [ ! -d "$GGML_PREFIX/libexec" ]; then
  echo 'FATAL: ggml libexec dir not found — backend plugins missing' >&2
  exit 1
fi
cp "$GGML_PREFIX/libexec/"libggml-*.so "$LIB_DIR/"

# libggml-cpu-apple_m*.so transitively links libomp (OpenMP runtime). macOS
# doesn't ship system OpenMP, so bundle it alongside the backends.
echo '==> Copying OpenMP runtime (transitive dep of CPU backend plugins)'
LIBOMP_PREFIX="$(brew --prefix libomp 2>/dev/null || true)"
if [ -z "$LIBOMP_PREFIX" ] || [ ! -d "$LIBOMP_PREFIX/lib" ]; then
  echo 'FATAL: libomp not found via Homebrew. Run: brew install libomp' >&2
  exit 1
fi
cp "$LIBOMP_PREFIX/lib/libomp.dylib" "$LIB_DIR/"

# Prune duplicate dylib name variants: Homebrew ships each library under three
# names (bare libfoo.dylib, libfoo.N.dylib, libfoo.N.M.P.dylib) — two of them
# as symlinks that `cp` above resolves into physical copies (~16 MB dead
# weight, tripled again after install_name_tool+codesign diverge the bytes).
# dyld resolves ONLY the install names recorded in the Mach-Os, and those are
# all single-major (@rpath/libllama.0.dylib, …) — verified by the @rpath
# resolution check further down, which fails the build if this prune ever
# removes a name some Mach-O actually references.
echo '==> Pruning unreferenced dylib name variants'
find "$LIB_DIR" -name 'lib*.*.*.*.dylib' -delete
for lib in "$LIB_DIR"/libllama.dylib "$LIB_DIR"/libllama-common.dylib \
  "$LIB_DIR"/libmtmd.dylib "$LIB_DIR"/libggml.dylib "$LIB_DIR"/libggml-base.dylib; do
  if [ -f "$lib" ]; then rm "$lib"; fi
done

# Sanity check: the copy commands above use `|| true` to be tolerant of layout
# variations across Homebrew versions. Without this guard a successful run
# could leave $LIB_DIR empty and the bug would only surface at runtime as a
# `dyld: Library not loaded` crash.
have_libllama=$(ls -1 "$LIB_DIR/"libllama*.dylib 2>/dev/null | wc -l | tr -d ' ')
have_libggml=$(ls -1 "$LIB_DIR/"libggml*.dylib 2>/dev/null | wc -l | tr -d ' ')
if [ "$have_libllama" -eq 0 ] || [ "$have_libggml" -eq 0 ]; then
  echo "FATAL: required dylibs missing in $LIB_DIR (libllama=$have_libllama libggml=$have_libggml)" >&2
  echo "  Check 'brew --prefix llama.cpp' and 'brew --prefix ggml' layouts." >&2
  exit 1
fi

# Make the bundle self-contained: every Mach-O (binary + every dylib) must
# resolve its dependencies via @rpath, not via absolute /opt/homebrew/...
# paths. Without this the DMG only works on Macs where Homebrew is installed
# at exactly the expected prefix. MUST run before the codesign step below —
# install_name_tool invalidates the Mach-O signature.
echo '==> Rewriting absolute /opt/homebrew dependencies to @rpath'
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
rewrite_macho "$BIN_DIR/llama-cli" binary
for macho in "$LIB_DIR/"*.dylib "$LIB_DIR/"*.so; do
  [ -f "$macho" ] && rewrite_macho "$macho" dylib
done

echo '==> Verifying bundle is self-contained (zero /opt/homebrew references)'
if otool -L "$BIN_DIR/llama-cli" "$LIB_DIR/"*.dylib "$LIB_DIR/"*.so | grep '/opt/homebrew'; then
  echo 'FATAL: bundle still references /opt/homebrew after rewrite — DMG would not work on Macs without Homebrew' >&2
  exit 1
fi

# Every @rpath install-name reference in the bundle must resolve to a file we
# actually ship. Guards the variant-prune above against a future Homebrew
# major bump (e.g. libllama.1.dylib) silently changing which names are loaded.
echo '==> Verifying every @rpath reference resolves inside the bundle'
unresolved="$(
  for macho in "$BIN_DIR/llama-cli" "$LIB_DIR"/*.dylib "$LIB_DIR"/*.so; do
    otool -L "$macho" | awk -v self="$(basename "$macho")" \
      '$1 ~ /^@rpath\// { sub(/^@rpath\//, "", $1); if ($1 != self) print $1 }'
  done | sort -u | while read -r dep; do
    if [ ! -f "$LIB_DIR/$dep" ]; then echo "$dep"; fi
  done
)"
if [ -n "$unresolved" ]; then
  echo 'FATAL: @rpath references without a bundled file — dyld would crash at runtime:' >&2
  echo "$unresolved" >&2
  exit 1
fi

echo '==> Re-signing all Mach-Os with ad-hoc signature'
codesign --force --sign - "$BIN_DIR/llama-cli"
for macho in "$LIB_DIR/"*.dylib "$LIB_DIR/"*.so; do
  [ -f "$macho" ] && codesign --force --sign - "$macho"
done

echo '==> Verifying binary'
"$BIN_DIR/llama-cli" --version

if [[ "${1:-}" == '--model' ]]; then
  MODEL_DIR="$HOME/.therascript/models/summarization"
  mkdir -p "$MODEL_DIR"
  MODEL_FILE="$MODEL_DIR/$GGUF_FILENAME"
  if [ ! -f "$MODEL_FILE" ]; then
    echo "==> Downloading Gemma 3 4B Instruct Q4_K_M (~2.5 GB)"
    # Prefer the new `hf` CLI (huggingface-hub >=0.26); fall back to the legacy
    # `huggingface-cli` for older installs, then to a direct curl (which fails
    # for gated repos like bartowski/gemma-3-4b-it-GGUF).
    if command -v hf >/dev/null 2>&1; then
      hf download "$GGUF_REPO" "$GGUF_FILENAME" --local-dir "$MODEL_DIR"
    elif command -v huggingface-cli >/dev/null 2>&1; then
      huggingface-cli download "$GGUF_REPO" \
        "$GGUF_FILENAME" --local-dir "$MODEL_DIR" --local-dir-use-symlinks False
    else
      echo "Neither hf nor huggingface-cli found — falling back to direct curl (will fail if gated)" >&2
      curl -L --fail -o "$MODEL_FILE" "$GGUF_URL"
    fi
  else
    echo "Model already present: $MODEL_FILE"
  fi
  echo '==> SHA-256:'
  shasum -a 256 "$MODEL_FILE"
fi

echo '==> Done'
