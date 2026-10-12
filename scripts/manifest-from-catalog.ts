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

const RELEASE_DOWNLOAD = 'https://github.com/adbstyle/therascripter/releases/download'

interface ManifestModel {
  id: string
  version: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
  minAppVersion?: string
}

interface ManifestApp {
  version: string
  url: string
  sha256: string
  sizeBytes: number
}

interface LiveManifest {
  models?: ManifestModel[]
  app?: ManifestApp
}

async function liveManifest(): Promise<LiveManifest> {
  const res = await fetch(`${R2_CDN}/manifest.json`)
  return res.ok ? ((await res.json()) as LiveManifest) : {}
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

  const today = new Date().toISOString().slice(0, 10)
  const liveManifestData = await liveManifest()
  const live = new Map((liveManifestData.models ?? []).map((m) => [m.id, m]))
  const problems: string[] = []
  const models: ManifestModel[] = []

  for (const m of MODEL_DEFINITIONS) {
    const head = await fetch(m.url, { method: 'HEAD' })
    const remoteSize = Number(head.headers.get('content-length'))
    if (!head.ok) {
      problems.push(`${m.id}: ${m.url} fehlt auf R2 (HTTP ${head.status})`)
    } else if (remoteSize !== m.sizeBytes) {
      problems.push(`${m.id}: R2 ${remoteSize} Bytes, Katalog ${m.sizeBytes} Bytes`)
    }
    const previous = live.get(m.id)
    const unchanged = previous?.sha256 === m.sha256
    models.push({
      id: m.id,
      version: unchanged ? previous.version : today,
      label: m.label,
      url: m.url,
      sha256: m.sha256,
      sizeBytes: m.sizeBytes,
      // Ab welcher App-Version das Artefakt passt (AK 2): ein unverändertes
      // behält seinen Wert, ein neues gilt erst ab der App, die es mitbringt.
      minAppVersion: (unchanged && previous.minAppVersion) || appVersion
    })
  }

  let app: ManifestApp | undefined
  if (dmgPath) {
    app = {
      version: appVersion,
      url: `${RELEASE_DOWNLOAD}/v${appVersion}/Therascript.dmg`,
      sha256: await sha256File(dmgPath),
      sizeBytes: statSync(dmgPath).size
    }
  } else if (liveManifestData.app?.version === appVersion) {
    app = liveManifestData.app
  } else {
    problems.push(
      `Kein --dmg und das Live-Manifest beschreibt nicht die App ${appVersion} — ` +
        'App-Eintrag fehlt (Release: release.sh übergibt das DMG)'
    )
  }

  if (problems.length > 0) {
    console.error('Manifest NICHT erzeugt:')
    problems.forEach((p) => console.error(`  ✗ ${p}`))
    if (problems.some((p) => p.includes('R2'))) {
      console.error('Fehlende Artefakte zuerst hochladen: scripts/upload-r2.sh r2-upload/<datei>')
    }
    process.exit(1)
  }

  const manifest = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    latestAppVersion: appVersion,
    app,
    models
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
