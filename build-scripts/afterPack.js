const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * Electron Fuses — hardened at build time (cannot be changed at runtime).
 * See: https://www.electronjs.org/docs/latest/tutorial/fuses
 */
module.exports = async function afterPack(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // Owner-Write-Bit auf ALLEN Dateien erzwingen. Homebrew-Bottles shippen
  // Mach-Os teils mit Modus 444/555, und die Setup-Skripte übernehmen den
  // Modus via `cp` nach resources/. «Dennoch öffnen» (Systemeinstellungen →
  // Datenschutz & Sicherheit) schreibt die Freigabe in JEDE Datei des Bundles
  // (ADR-009); auf einer Datei ohne u+w bleibt die unfreigegebene Quarantäne
  // stehen und Gatekeeper killt das ad-hoc-signierte Binary beim Spawn per
  // SIGKILL, ohne stderr. chmod verändert keine Mach-O-Bytes
  // und invalidiert keine Signatur. Chokepoint hier statt in den einzelnen
  // Setup-Skripten: deckt jede Ressource ab, egal wie sie in die App kam.
  execFileSync('chmod', ['-R', 'u+w', appPath])
  console.log(`Owner-write bit ensured on ${appPath}`)

  const electronBinary = path.join(
    appPath,
    'Contents',
    'MacOS',
    context.packager.appInfo.productFilename
  )

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log(`Electron Fuses applied to ${electronBinary}`)

  signWithStableRequirement(appPath, context.packager.appInfo.id)
}

/**
 * Ad-hoc-Signatur mit expliziter Designated Requirement (ADR-009, Issue #161).
 *
 * flipFuses signiert ad-hoc, und eine ad-hoc-Signatur hat per Default die
 * Requirement `cdhash H"…"` — die ändert sich mit jedem Build. macOS bindet die
 * Mikrofon-Berechtigung (TCC) und den Schlüsselbund-Eintrag «Therascript Safe
 * Storage» an diese Requirement, also gingen beide bei jedem Update verloren.
 * Mit `designated => identifier "<bundle-id>"` bleiben sie erhalten.
 *
 * Reihenfolge: zuerst die Helper-Apps, zuletzt die Haupt-App — deren Siegel
 * deckt die verschachtelten Signaturen ab und muss sie im Endzustand sehen.
 * Bewusst ohne --deep: das würde die Requirement der Haupt-App auf jeden
 * verschachtelten Bundle stempeln. Die Werkzeuge unter Contents/Resources
 * (whisper, llama, vision-ocr, Python) behalten ihre eigenen Signaturen und
 * werden von der Haupt-App nur als Ressourcen versiegelt.
 *
 * Keine Entitlements: --preserve-metadata übernimmt nur, was flipFuses schon
 * gesetzt hat. Eine app-sandbox-Entitlement bräche ~/.therascript und alle
 * Subprozesse.
 */
function signWithStableRequirement(appPath, appBundleId) {
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks')
  const helpers = fs
    .readdirSync(frameworksDir)
    .filter((name) => name.endsWith('.app'))
    .map((name) => path.join(frameworksDir, name))

  for (const helperPath of helpers) {
    signBundle(helperPath, readBundleId(helperPath))
  }
  signBundle(appPath, appBundleId)
}

function signBundle(bundlePath, bundleId) {
  execFileSync('codesign', [
    '--force',
    '--sign',
    '-',
    '--preserve-metadata=entitlements,flags,runtime',
    `-r=designated => identifier "${bundleId}"`,
    bundlePath
  ])
  console.log(`Signed ${path.basename(bundlePath)} with designated => identifier "${bundleId}"`)
}

function readBundleId(bundlePath) {
  return execFileSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', path.join(bundlePath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  ).trim()
}
