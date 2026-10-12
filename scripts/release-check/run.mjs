#!/usr/bin/env node
/**
 * Release-Prüfung (Issue #170): Prüft eine gepackte App, bevor sie
 * veröffentlicht wird. Einen Rückweg zur Vorversion gibt es nicht (ADR-009),
 * diese Prüfung ist das Sicherheitsnetz.
 *
 *   1. Start ohne Daten bis zur Ersteinrichtung
 *   2. Start auf dem Seed der zuletzt veröffentlichten Version: alle
 *      Sitzungen in der Liste, alle Inhalte erhalten, die wartende Sitzung
 *      läuft weiter
 *   3. Eine neue Aufnahme und ein PDF (Text- und eingescannte Seite) laufen
 *      bis zur Zusammenfassung
 *
 * Läuft isoliert (eigenes Home, Sandbox gegen die echten Daten, kein
 * Internet), siehe lib/instance.mjs. Braucht die Modelle des Release-Macs
 * inklusive Zusammenfassungsmodell und `gh` mit Zugriff auf die Releases.
 *
 * Usage: node scripts/release-check/run.mjs --app dist/mac-arm64/Therascript.app [--prev-tag vX.Y.Z]
 * Exit 0 = alle Prüfungen grün, 1 = mindestens eine rot oder nicht durchführbar.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { checkFreshStart, checkSeededRun } from './lib/checks.mjs'
import { ensureSeed } from './lib/seed.mjs'
import { LOG_DIR, previousApp, previousReleaseTag } from './lib/workspace.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtures = {
  wav: join(ROOT, 'tests', 'fixtures', 'release-check', 'gespraech.wav'),
  pdf: join(ROOT, 'tests', 'fixtures', 'release-check', 'bericht.pdf'),
  // Wörter, die nur auf der Textseite bzw. nur auf der eingescannten Seite
  // stehen (build-fixtures.mjs) — beide müssen im Ergebnis auftauchen
  pdfTextPageWord: 'Verlaufsbericht',
  pdfScanPageWord: 'Nachtrag'
}

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const appPath = arg('--app') && resolve(arg('--app'))
if (!appPath) {
  console.error(
    'Usage: node scripts/release-check/run.mjs --app <Therascript.app> [--prev-tag vX.Y.Z]'
  )
  process.exit(2)
}

const started = Date.now()
const log = (message) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${message}`)
mkdirSync(LOG_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const logFile = join(LOG_DIR, `release-check-${stamp}.log`)

const results = []
async function step(name, fn) {
  try {
    results.push(...(await fn()))
  } catch (err) {
    results.push({ name, ok: false, detail: `nicht durchführbar: ${err.message}` })
  }
}

let prevTag
await step('Voraussetzungen', async () => {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error(`Node ${process.version} hat kein WebSocket — Node 22 oder neuer nötig`)
  }
  if (!existsSync(appPath)) throw new Error(`App nicht gefunden: ${appPath}`)
  for (const file of [fixtures.wav, fixtures.pdf]) {
    if (!existsSync(file)) throw new Error(`Testdaten fehlen: ${file}`)
  }
  const version = execFileSync(
    'plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  ).trim()
  prevTag = arg('--prev-tag') ?? previousReleaseTag(version)
  log(`Prüfe ${version} gegen die Vorversion ${prevTag}`)
  return []
})

if (prevTag) {
  await step('Start ohne Daten bis zur Ersteinrichtung', async () => {
    log('Start ohne Daten …')
    return checkFreshStart({ appPath, logFile })
  })

  await step('Start auf dem Seed der Vorversion', async () => {
    const expectations = await ensureSeed({
      tag: prevTag,
      appPath: previousApp(prevTag),
      fixtures,
      logFile,
      log
    })
    log('Start auf dem Seed der Vorversion …')
    return checkSeededRun({ appPath, logFile, expectations, fixtures, log })
  })
}

const failed = results.filter((r) => !r.ok)
console.log('\nRelease-Prüfung')
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
}
const report = join(LOG_DIR, `release-check-${stamp}.json`)
writeFileSync(report, JSON.stringify({ appPath, prevTag, results }, null, 2))
console.log(`\nDauer ${Math.round((Date.now() - started) / 1000)} s. App-Log: ${logFile}`)
if (failed.length) {
  console.log(`RELEASE-PRÜFUNG ROT: ${failed.length} von ${results.length} Prüfungen gescheitert`)
  process.exit(1)
}
console.log(`RELEASE-PRÜFUNG GRÜN: ${results.length} Prüfungen`)
