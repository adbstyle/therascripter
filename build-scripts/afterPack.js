/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { execFileSync } = require('child_process')
const path = require('path')

/**
 * Electron Fuses — hardened at build time (cannot be changed at runtime).
 * See: https://www.electronjs.org/docs/latest/tutorial/fuses
 */
module.exports = async function afterPack(context) {
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // Owner-Write-Bit auf ALLEN Dateien erzwingen. Homebrew-Bottles shippen
  // Mach-Os teils mit Modus 444/555, und die Setup-Skripte übernehmen den
  // Modus via `cp` nach resources/. Ohne u+w schlägt auf Endnutzer-Macs die
  // Gatekeeper-Anleitung `xattr -cr` mit EACCES fehl (xattr braucht
  // Write-Permission, Ownership reicht nicht) — die Quarantäne bleibt auf
  // genau diesen Dateien und Gatekeeper killt das ad-hoc-signierte Binary
  // beim Spawn per SIGKILL, ohne stderr. chmod verändert keine Mach-O-Bytes
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
}
