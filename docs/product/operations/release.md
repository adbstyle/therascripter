# Release Process

## Overview

Therascript releases are built as macOS DMG installers targeting Apple Silicon (arm64 only). The release flow is driven by an interactive shell script (`scripts/release.sh`) that bumps the version, builds the DMG, and publishes a GitHub Release via the `gh` CLI.

## Release Flow

### scripts/release.sh

The release script performs these steps in order:

1. **Version selection** — Reads the current version from `package.json` and presents an interactive menu with four options: patch bump, minor bump, major bump, or a custom version string. The version must match semver format (`X.Y.Z`).

2. **Release notes** — Optionally prompts for a one-line release note. If left empty, GitHub auto-generates notes from commit history.

3. **Version bump** — Writes the new version into `package.json` using Node.js.

4. **Git commit + tag** — Stages `package.json`, commits with message `chore: bump version to X.Y.Z`, and creates an annotated git tag `vX.Y.Z`. Skips the commit if `package.json` is unchanged; skips the tag if it already exists.

5. **Push** — Pushes the commit and tag to the remote (`git push origin HEAD` + `git push origin vX.Y.Z`).

6. **Build DMG** — Runs `npm run package` to produce the DMG (see Build section below).

7. **Locate DMG** — Expects the output at `dist/Therascript-X.Y.Z-arm64.dmg`. Exits with an error if the file is missing.

8. **GitHub Release** — Creates a release via `gh release create vX.Y.Z` with the DMG attached. Uses custom release notes if provided, otherwise `--generate-notes`.

9. **Update manifest** — Runs `scripts/publish-manifest.sh --app-version-only` to update `latestAppVersion` in the R2 manifest so the in-app update check picks up the new version. Warns (but does not fail) if this step errors.

## Build Pipeline

### npm run package

The `package` script runs three stages:

1. **electron-rebuild** — Rebuilds native modules (notably better-sqlite3) against the Electron ABI.
2. **electron-vite build** — TypeScript type-check + Vite production build of main, preload, and renderer processes.
3. **electron-builder** — Packages the app into a DMG using `electron-builder.yml`.

### electron-builder.yml Key Settings

| Setting | Value | Purpose |
|---|---|---|
| `appId` | `com.therascript.app` | macOS bundle identifier |
| `productName` | `Therascript` | Display name in Finder and menu bar |
| `directories.buildResources` | `build` | Icons, build assets |
| `directories.output` | `dist` | Where the DMG lands |
| `npmRebuild` | `false` | Prevents electron-builder's own unreliable native rebuild; the `package` script runs `electron-rebuild` explicitly instead |
| `mac.target` | `dmg` / `arm64` | Single target: DMG for Apple Silicon only |
| `mac.category` | `public.app-category.medical` | macOS App Store category |
| `mac.identity` | `null` | Disables code signing (no Apple Developer certificate) |
| `afterPack` | `build-scripts/afterPack.js` | Post-pack hook for Electron Fuses + re-signing |

#### Extra Resources

The builder copies these into the `.app` bundle:

- `resources/bin` and `resources/lib` — whisper.cpp binary and shared libraries
- `python_sidecar/standalone` — Relocatable Python runtime (built via `uv`)
- `python_sidecar/diarize.py`, `ner_service.py`, `torchcodec_shim.py` — ML sidecar scripts

#### File Exclusions

Source code, tests, config files, documentation, scripts, and development artifacts are excluded from the bundle via `files` negation patterns.

#### DMG Layout

The DMG presents a standard macOS drag-to-install layout with the app icon on the left (x: 130) and an Applications folder alias on the right (x: 410).

## Electron Fuses and Ad-Hoc Signing

### build-scripts/afterPack.js

This hook runs after electron-builder packages the app but before the DMG is created. It performs two critical operations:

**1. Flip Electron Fuses**

Fuses are compile-time feature flags embedded in the Electron binary. Once flipped, they cannot be changed at runtime. The following fuses are configured:

| Fuse | Value | Effect |
|---|---|---|
| `RunAsNode` | `false` | Prevents using the Electron binary as a plain Node.js runtime |
| `EnableCookieEncryption` | `true` | Encrypts cookies stored on disk |
| `EnableNodeOptionsEnvironmentVariable` | `false` | Ignores `NODE_OPTIONS` env var (prevents injection) |
| `EnableNodeCliInspectArguments` | `false` | Disables `--inspect` / `--inspect-brk` flags |
| `EnableEmbeddedAsarIntegrityValidation` | `false` | Disabled (requires proper code signing to work) |
| `OnlyLoadAppFromAsar` | `true` | Only loads app code from the asar archive (prevents sideloading) |

**2. Ad-Hoc Re-Signing**

The `resetAdHocDarwinSignature: true` option in `flipFuses()` re-signs the Electron binary with an ad-hoc signature (`codesign --sign -`) after modifying the fuses. This is required because flipping fuses changes the binary's content, which invalidates any existing signature. On ARM64 macOS, an unsigned or invalidly-signed binary is killed on launch with `CODESIGNING, Code 2 Invalid Page`.

The order matters: fuses must be flipped first, then the binary must be re-signed. The `@electron/fuses` library handles both in a single call when `resetAdHocDarwinSignature` is set.

## Code Signing

Therascript is not signed with an Apple Developer certificate. The implications:

- `mac.identity: null` in `electron-builder.yml` tells electron-builder to skip its signing step entirely.
- `afterPack.js` applies an ad-hoc signature (`codesign --sign -`) after flipping fuses. This satisfies the ARM64 signature requirement but does not establish trust with macOS Gatekeeper.
- The ad-hoc signature means the app is recognized as "from an unidentified developer" by macOS.

## Gatekeeper

Because the app lacks a Developer ID signature and is not notarized, macOS Gatekeeper blocks it on first launch. Users must bypass this:

1. **Right-click (or Control-click) the app** in Finder
2. **Select "Open"** from the context menu
3. **Click "Open"** in the confirmation dialog

This only needs to be done once per downloaded version. After the first launch, macOS remembers the user's choice and the app opens normally.

## Version Management

- The version lives in `package.json` as the `version` field (semver: `MAJOR.MINOR.PATCH`).
- `scripts/release.sh` is the sole mechanism for bumping the version. It writes directly to `package.json` via Node.js.
- Git tags follow the format `vX.Y.Z` (e.g., `v1.2.3`) and are annotated tags.
- electron-builder reads the version from `package.json` automatically and uses it in the DMG filename (`Therascript-X.Y.Z-arm64.dmg`).

## GitHub Release

- Created via `gh release create vX.Y.Z` (GitHub CLI).
- The release title is `Therascript vX.Y.Z`.
- The DMG file is attached as a release asset.
- Release notes are either user-provided (from the interactive prompt) or auto-generated from commits since the previous tag.
- The release URL follows the pattern: `https://github.com/adbstyle/therascripter/releases/tag/vX.Y.Z`

## Prerequisites

- `gh` CLI must be installed and authenticated (`gh auth login`)
- Node.js and npm dependencies installed (`npm install`)
- For the full pipeline: whisper.cpp built (`scripts/setup-whisper.sh`), Python sidecar built (`npm run sidecar:build`), Vision OCR helper built (`scripts/setup-vision-ocr.sh`)
- Git working tree should be clean before running the release script
- R2 credentials in `.env` if the manifest update step should succeed
