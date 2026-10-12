# Release Process

## Overview

Therascript releases are built as macOS DMG installers targeting Apple Silicon (arm64 only). The release flow is driven by `scripts/release.sh`, which bumps the version, builds the DMG, runs the verify+smoke release gate, and publishes a GitHub Release via the `gh` CLI. The script has two modes:

- **Interactive** (no arguments): prompts for the version choice, a confirmation, and optional release notes.
- **Non-interactive** (`--bump patch|minor|major` or `--version X.Y.Z`, plus `--notes "text"` or `--notes-file <path>`): no prompts; intended for automated releases (e.g. Claude-driven). Refuses to run on any branch other than `main` — that guard replaces the human confirmation prompt. All flag inputs (bump value, version format, notes-file existence, mutually exclusive flag combinations) are validated up front, before anything is built or pushed.

The end-user install guide (`scripts/release-install-guide.md`) is **always** appended to the release notes, regardless of how the notes were produced. The same guide appears on the website (`website/installation.html`, linked from every download button), in README.md ("Installation") and in short form in the DMG window (`build/dmg-background.svg`, rendered via `npm run dmg:background`). Keep steps and facts (macOS floor, model size, disk space) identical at all four places.

## Release Flow

### scripts/release.sh

The release script performs these steps in order:

1. **Input resolution** — Parses and validates flags (or prompts interactively), resolves the notes body from `--notes-file` > `--notes` > interactive input, and fails fast on any invalid input.

2. **Version bump** — Writes the new version into `package.json` using Node.js and commits it **locally only** (`chore: bump version to X.Y.Z`). Skips the commit if `package.json` is unchanged.

3. **Build DMG** — Runs `npm run package` to produce the DMG (see Build section below).

4. **Locate DMG** — Expects the output at `dist/Therascript.dmg`. Exits with an error if the file is missing (the local version commit can be undone with `git reset HEAD~1`).

5. **Verify + Smoke (release gate)** — Runs `scripts/verify-bundles.sh --app dist/mac-arm64/Therascript.app --smoke`. On failure the release aborts here: nothing has been tagged or pushed yet.

6. **Release check (Issue #170)** — Runs `node scripts/release-check/run.mjs --app dist/mac-arm64/Therascript.app` (details below). Red means abort; `--override-release-check "<reason>"` (or, interactively, a reason typed at the prompt) releases anyway and records the reason in the tag message and the release notes.

7. **Update description dry run (Issue #163)** — `publish-manifest.sh --from-catalog --dmg dist/Therascript.dmg --dry-run` builds and signs the manifest locally. A missing model artifact on R2 or a missing/untrusted signing key aborts here, before anything is pushed.

8. **Tag + push** — Only after green gates: creates the annotated tag `vX.Y.Z` (skipped if it exists) and pushes commit + tag.

9. **GitHub Release** — If no notes were provided, generates them from commit history via `gh api repos/{owner}/{repo}/releases/generate-notes` (must run after the tag push; the built-in `--generate-notes` flag cannot be combined with `--notes-file`, which is needed for the appended install guide). A failed generation is reported loudly but does not abort — the release then ships with the install guide only. Creates the release **as a draft** via `gh release create vX.Y.Z --draft --notes-file …` with the DMG attached — not public yet (release page, website «latest» download).

10. **Signed update description + publish** — Checks that the DMG in the draft has the local sha256 (asset `digest`), then runs `scripts/publish-manifest.sh --from-catalog --dmg dist/Therascript.dmg`: model entries from `src/shared/model-catalog.ts` (each checked against R2 via HEAD; since #167 with their layout `relativePath`/`checkPath`/`archive`/`group`/`required`, and `minAppVersion` = the first release that ships the artifact — an app takes a model update only with an app version ≥ `minAppVersion`; an artifact old app versions cannot load needs a **new model id and folder**, see CLAUDE.md), an `app` entry (version, URL, size, sha256 of the DMG), Ed25519 signature uploaded first to `signatures/<sha256>.json`, then `manifest.json`, then both re-fetched from the public URL. Only then the draft is published (`gh release edit --draft=false --latest`) and the download URL is checked. Any failure **aborts with exit 1** and the next command; before the publish step the version stays a non-public draft. New artifacts must be on R2 before releasing (see `model-pipeline.md`).

### Release check (scripts/release-check/)

There is no way back to a previous version in the app (ADR-009) and updates install themselves (#164), so every release proves before tagging that the packaged app starts, keeps the data of the last published version and processes recordings and PDFs. Checks:

| Check | What it proves |
|---|---|
| Start without data | The app reaches the first-launch screen («Download starten») |
| Start on the seed of the previous version | The session list shows every seed session; transcripts with edits and speakers, placeholder mapping, summaries, status, Sperrliste, settings and task history are unchanged; the seed's waiting session runs through to a summary |
| Recording and PDF | A short recording (fed through the recording IPC, no microphone) and a PDF with a text and a scanned page reach `review` **with** a summary (the app skips summaries silently, the check does not) |

A check that cannot run (missing previous DMG, missing models, timeout) counts as failed. The report lists every check with its reason; app output goes to `~/Library/Caches/therascript-release-check/logs/`.

**Isolation.** The packaged app runs with `CFFIXED_USER_HOME=<test home>` (CoreFoundation, hence `app.getPath('home')`, reads it before `HOME`), `--use-mock-keychain` (otherwise macOS asks for a keychain in the test home) and `--no-sandbox`, inside `sandbox-exec` that denies `~/.therascript`, `~/Library/Application Support/therascript` and outbound 80/443 (update check). Never deny `fdesetup`: `execFile` then throws synchronously and `checkFileVaultOnStartup` aborts the startup before `taskQueue.start()`. Every launch asserts `aboutInfo().dataDir`. The app is quit with a targeted macOS quit (`NSRunningApplication.terminate`), not SIGTERM — the bundled `atomically` swallows SIGTERM. Models are APFS clones of the release Mac's `~/.therascript/models`. No product change was needed, so the published previous version runs the same way.

**Seed.** The previous release (`gh release download <tag>`, extracted to the cache) builds it through its own UI API: settings, Sperrliste (all 7 types), a recording and a PDF processed to `review` with summary, the recording edited (text, speaker), then — while a second recording runs — a PDF import (waits, the queue pauses during recordings) and a quit: the recording ends as `error`, the PDF stays `queued`. Never a `recording` session: it opens a native recovery dialog at startup. The seed is cached per tag under `~/Library/Caches/therascript-release-check/seeds/<tag>/` (first release after a new version pays ~5 min once). The DB stores absolute paths, so build and check always use the same home (`…/therascript-release-check/home`); timestamps are shifted to «now» before every check (30-day auto-deletion, 24-h source cleanup). When a version introduces a new kind of data, extend `lib/seed.mjs` in the same release (NFR 6).

**Test data** (`tests/fixtures/release-check/`, invented, no patient data): `gespraech.wav` (~20 s, two voices, recording format) and `bericht.pdf` (text page + scanned page). Regenerate with `node scripts/release-check/build-fixtures.mjs`.

The seed cache key is `<tag>-<hash of seed.mjs, app-actions.mjs and the fixtures>`: extending the seed builds a new seed instead of reusing an old one. Settings compared exactly are the user-set ones (`theme`, `reviewPanelOpen`, `consentReminderShown`); for `activeModels` the check only requires every active model to be installed, because a new version may replace models on purpose (e.g. retiring a model).

**Update path from the previous version** (#164 PC 8): not automated yet — the first release with the in-app updater has no predecessor that could update itself. From the second such release on, extend the release check: install the previous version into the test home's `~/Applications`, serve a manifest signed for the new DMG (the manifest base URL is hardcoded; this needs a test hook) and let the previous version update itself. Until then the manual check covers it.

**Not covered** (manual check, ADR-009): Gatekeeper behaviour, first launch with model download, older versions than the last release, ML quality. Known gap: the seed has no session whose task was *running* when the previous version quit (`processing`, recovered by `recoverStuckTasks`), because such a state cannot be produced reproducibly through the UI API — the `queued` session covers the resume path only.

### Signing keys (Issue #163)

The app trusts the Ed25519 public keys in `src/shared/update-keys.ts` (`UPDATE_SIGNING_KEYS`). Two keys per generation:

- **Primary** (`primary-YYYY-MM`): private key in the login keychain of the release Mac (service `therascript-update-signing`). `scripts/sign-manifest.ts` reads it; macOS asks once, «Immer erlauben» makes every later release sign without a prompt. Never in the repo, `.env` or the app bundle — `verify-bundles.sh` fails on key files or key material in `app.asar`.
- **Backup** (`backup-YYYY-MM`): private key offline in the publisher's password manager. Used only if the primary is lost: `THERASCRIPT_SIGNING_KEY_FILE=<file with the base64 key> scripts/publish-manifest.sh --from-catalog --dmg …`.

Created once with `npx tsx scripts/generate-signing-keys.ts` (writes the public keys into `update-keys.ts`; no private key is printed).

**Planned rotation / after loss** (no reinstall):

1. `npx tsx scripts/generate-signing-keys.ts --rotate` appends a new pair to `UPDATE_SIGNING_KEYS` (old entries stay) and stores the new primary as `therascript-update-signing-next` in the keychain; the new backup goes to a desktop file → password manager.
2. Ship a release that trusts both generations, signed with the current primary — after a **loss** with the backup key (`THERASCRIPT_SIGNING_KEY_FILE=…`).
3. Once that release is widespread: `npx tsx scripts/generate-signing-keys.ts --activate-next` (the successor becomes the signing key).
4. Drop the retired entries from `update-keys.ts` in a later release.

After a **theft** an attacker can sign; then a one-time manual reinstall with new keys is accepted (Issue #163, Out of Scope 2).

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
- `afterPack.js` applies an ad-hoc signature (`codesign --sign -`) after flipping fuses, then re-signs the helper apps and the main app with `designated => identifier "<bundle-id>"` so the microphone permission and keychain access survive updates (ADR-009, Issue #161; checked by `verify-bundles.sh --app`). This satisfies the ARM64 signature requirement but does not establish trust with macOS Gatekeeper.
- The ad-hoc signature means the app is recognized as "from an unidentified developer" by macOS.

## Gatekeeper

Because the app lacks a Developer ID signature and is not notarized, macOS 26 blocks the first launch of a browser-downloaded version with «"Therascript" Not Opened — Apple could not verify …» (buttons «Done» / «Move to Bin»). Users then allow it once per downloaded version in System Settings → Privacy & Security → «Open Anyway» («Dennoch öffnen»). No Terminal command is needed (ADR-009, verified with 0.8.13 on macOS 26.5).

«Open Anyway» writes the approval into the quarantine attribute of **every** file in the bundle. A file without the owner-write bit keeps its unapproved quarantine and Gatekeeper SIGKILLs it on spawn (silent summarization skip, failing transcription). That is why the u+w gate in `verify-bundles.sh` (plus the `chmod` in `afterPack.js`) decides whether installation works without Terminal. Versions up to 0.8.7 shipped read-only files and needed the old `chmod … && xattr -cr …` command.

Gatekeeper cannot be tested from a developer shell (quarantined binaries run there without approval). Releases that change installation, update path, signature or bundle layout need the manual check from ADR-009 ("Prüfung vor jedem Release").

## Version Management

- The version lives in `package.json` as the `version` field (semver: `MAJOR.MINOR.PATCH`).
- `scripts/release.sh` is the sole mechanism for bumping the version. It writes directly to `package.json` via Node.js.
- Git tags follow the format `vX.Y.Z` (e.g., `v1.2.3`) and are annotated tags.
- electron-builder reads the version from `package.json` automatically; the DMG filename is version-less (`Therascript.dmg`, via `artifactName` in `electron-builder.yml`) so the website's `releases/latest/download/Therascript.dmg` link stays stable.

## GitHub Release

- Created via `gh release create vX.Y.Z --notes-file …` (GitHub CLI).
- The release title is `Therascript vX.Y.Z`.
- The DMG file is attached as a release asset.
- Release notes body: provided via `--notes`/`--notes-file`, entered at the interactive prompt, or generated from commits since the previous tag (`generate-notes` API). The install guide (`scripts/release-install-guide.md`) is always appended after a `---` separator.
- The release URL follows the pattern: `https://github.com/adbstyle/therascripter/releases/tag/vX.Y.Z`

## Prerequisites

- `gh` CLI must be installed and authenticated (`gh auth login`)
- Node.js and npm dependencies installed (`npm install`)
- For the full pipeline: whisper.cpp built (`scripts/setup-whisper.sh`), Python sidecar built (`npm run sidecar:build`), Vision OCR helper built (`scripts/setup-vision-ocr.sh`)
- Git working tree should be clean before running the release script
- R2 credentials in `.env` if the manifest update step should succeed
