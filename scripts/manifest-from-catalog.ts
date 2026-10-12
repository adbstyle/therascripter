#!/usr/bin/env -S npx tsx
/**
 * Builds manifest.json from src/shared/model-catalog.ts and prints it to stdout:
 *
 *   npx tsx scripts/manifest-from-catalog.ts <latestAppVersion> [--dmg <Therascript.dmg>]
 *
 * Issue #163: The manifest also describes the app itself (`app`: version, DMG
 * URL on the GitHub release, size, sha256 — computed from the DMG that was
 * uploaded) and states per model from which app version on it fits
 * (`minAppVersion`). Without --dmg the live `app` entry is kept, but only if it
 * already describes this version (model-only republish). The format stays
 * readable for installations without signature checks: they ignore the new
 * fields, `latestAppVersion` keeps its meaning.
 *
 * Used by `publish-manifest.sh --from-catalog`, which release.sh calls. That way
 * the published manifest always matches the catalog of the app being released.
 * The old path patched only latestAppVersion, so a new artifact (e.g. the fp16
 * NER v3) shipped with the app's built-in hash while the manifest still pointed
 * to the previous one. UpdateCheckService then offered fresh installs a
 * "model update" BACK to the old artifact, because the update trigger is a pure
 * sha mismatch.
 *
 * Needs no local files in r2-upload/: every artifact is checked against R2 with
 * a HEAD request (exists, Content-Length == catalog sizeBytes) — the same size
 * preflight that publish-manifest.sh does in full mode. Exit 1 if anything is
 * missing or differs; then nothing gets published.
 *
 * `version` stays the live manifest's value for models whose sha is unchanged
 * and becomes today's date for changed ones. It is purely informational
 * (updates are triggered by sha), but resetting every date would claim updates
 * that never happened.
 */

import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { MODEL_DEFINITIONS, R2_CDN } from '../src/shared/model-catalog'
import { buildManifest, type ManifestApp, type ManifestModel } from '../src/shared/update-manifest'

const RELEASE_DOWNLOAD = 'https://github.com/adbstyle/therascripter/releases/download'

async function liveManifest(): Promise<{ models?: ManifestModel[]; app?: ManifestApp }> {
  const res = await fetch(`${R2_CDN}/manifest.json`)
  return res.ok ? ((await res.json()) as { models?: ManifestModel[]; app?: ManifestApp }) : {}
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function main(): Promise<void> {
  const appVersion = process.argv[2]
  const dmgIndex = process.argv.indexOf('--dmg')
  const dmgPath = dmgIndex > 0 ? process.argv[dmgIndex + 1] : undefined
  if (!appVersion || (dmgIndex > 0 && !dmgPath)) {
    console.error('Usage: manifest-from-catalog.ts <latestAppVersion> [--dmg <Therascript.dmg>]')
    process.exit(1)
  }

  const problems: string[] = []
  for (const m of MODEL_DEFINITIONS) {
    const head = await fetch(m.url, { method: 'HEAD' })
    const remoteSize = Number(head.headers.get('content-length'))
    if (!head.ok) {
      problems.push(`${m.id}: ${m.url} fehlt auf R2 (HTTP ${head.status})`)
    } else if (remoteSize !== m.sizeBytes) {
      problems.push(`${m.id}: R2 ${remoteSize} Bytes, Katalog ${m.sizeBytes} Bytes`)
    }
  }
  if (problems.length > 0) {
    console.error('Katalog und R2 stimmen nicht überein — Manifest NICHT erzeugt:')
    problems.forEach((p) => console.error(`  ✗ ${p}`))
    console.error('Zuerst das Artefakt hochladen: scripts/upload-r2.sh r2-upload/<datei>')
    process.exit(1)
  }

  const dmg = dmgPath
    ? {
        url: `${RELEASE_DOWNLOAD}/v${appVersion}/Therascript.dmg`,
        sha256: await sha256File(dmgPath),
        sizeBytes: statSync(dmgPath).size
      }
    : undefined
  const manifest = buildManifest({
    catalog: MODEL_DEFINITIONS,
    live: await liveManifest(),
    appVersion,
    dmg,
    now: new Date()
  })
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
