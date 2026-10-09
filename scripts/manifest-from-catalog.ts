#!/usr/bin/env -S npx tsx
/**
 * Builds manifest.json from src/shared/model-catalog.ts and prints it to stdout:
 *
 *   npx tsx scripts/manifest-from-catalog.ts <latestAppVersion>
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

import { MODEL_DEFINITIONS, R2_CDN } from '../src/shared/model-catalog'

interface ManifestModel {
  id: string
  version: string
  label: string
  url: string
  sha256: string
  sizeBytes: number
}

async function liveVersions(): Promise<Map<string, ManifestModel>> {
  const res = await fetch(`${R2_CDN}/manifest.json`)
  if (!res.ok) return new Map()
  const live = (await res.json()) as { models?: ManifestModel[] }
  return new Map((live.models ?? []).map((m) => [m.id, m]))
}

async function main(): Promise<void> {
  const appVersion = process.argv[2]
  if (!appVersion) {
    console.error('Usage: manifest-from-catalog.ts <latestAppVersion>')
    process.exit(1)
  }

  const today = new Date().toISOString().slice(0, 10)
  const live = await liveVersions()
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
    models.push({
      id: m.id,
      version: previous?.sha256 === m.sha256 ? previous.version : today,
      label: m.label,
      url: m.url,
      sha256: m.sha256,
      sizeBytes: m.sizeBytes
    })
  }

  if (problems.length > 0) {
    console.error('Katalog und R2 stimmen nicht überein — Manifest NICHT erzeugt:')
    problems.forEach((p) => console.error(`  ✗ ${p}`))
    console.error('Zuerst das Artefakt hochladen: scripts/upload-r2.sh r2-upload/<datei>')
    process.exit(1)
  }

  const manifest = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    latestAppVersion: appVersion,
    models
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
