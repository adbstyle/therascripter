/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const path = require('path')

/**
 * Electron Fuses — hardened at build time (cannot be changed at runtime).
 * See: https://www.electronjs.org/docs/latest/tutorial/fuses
 */
module.exports = async function afterPack(context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  const electronBinary = path.join(
    appPath,
    'Contents',
    'MacOS',
    context.packager.appInfo.productFilename
  )

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log(`Electron Fuses applied to ${electronBinary}`)
}
