/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { execSync, execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

/**
 * Post-process DMG to enforce Finder view settings (window size, icon size, background).
 *
 * macOS Tahoe (26.x) Finder ignores the .DS_Store written by electron-builder's dmg-builder
 * on first mount. Workaround: convert to UDRW, mount, drive Finder via AppleScript so it
 * writes its own authoritative .DS_Store, then convert back to UDZO.
 *
 * Wired into electron-builder via `afterAllArtifactBuild` in electron-builder.yml.
 */
module.exports = async function finalizeDmg(buildResult) {
  const dmgPaths = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'))

  if (dmgPaths.length === 0) {
    console.log('[finalize-dmg] No DMG artifacts found, skipping')
    return []
  }

  for (const dmgPath of dmgPaths) {
    await finalizeSingleDmg(dmgPath)
  }

  return []
}

async function finalizeSingleDmg(dmgPath) {
  const tmpDmg = dmgPath.replace(/\.dmg$/, '-rw.dmg')
  const scriptPath = path.join(__dirname, 'finalize-dmg.applescript')

  console.log(`[finalize-dmg] Processing ${dmgPath}`)

  try {
    fs.unlinkSync(tmpDmg)
  } catch (_) {
    // ignore
  }

  console.log('[finalize-dmg]   → converting UDZO → UDRW')
  execSync(`hdiutil convert "${dmgPath}" -format UDRW -ov -o "${tmpDmg}"`, { stdio: 'inherit' })

  console.log('[finalize-dmg]   → mounting read-write')
  const attachOutput = execSync(
    `hdiutil attach "${tmpDmg}" -readwrite -noverify -noautoopen`,
    { encoding: 'utf8' }
  )
  const mountLine = attachOutput
    .split('\n')
    .reverse()
    .find((l) => l.includes('/Volumes/'))
  if (!mountLine) {
    throw new Error('Could not parse mount point from hdiutil attach output')
  }
  const mountPoint = mountLine.split('\t').pop().trim()
  const volumeName = path.basename(mountPoint)
  console.log(`[finalize-dmg]   → mounted at ${mountPoint}`)

  try {
    console.log('[finalize-dmg]   → running AppleScript to set Finder view')
    execFileSync('osascript', [scriptPath, volumeName], { stdio: 'inherit' })
    execSync('sync')
  } finally {
    console.log('[finalize-dmg]   → unmounting')
    try {
      execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: 'inherit' })
    } catch (err) {
      console.error('[finalize-dmg]   → detach failed:', err.message)
    }
  }

  console.log('[finalize-dmg]   → converting UDRW → UDZO')
  execSync(
    `hdiutil convert "${tmpDmg}" -format UDZO -ov -imagekey zlib-level=9 -o "${dmgPath}"`,
    { stdio: 'inherit' }
  )

  fs.unlinkSync(tmpDmg)
  console.log(`[finalize-dmg]   ✓ done`)
}

if (require.main === module) {
  const dmg = process.argv[2]
  if (!dmg) {
    console.error('Usage: node finalize-dmg.js <path-to-dmg>')
    process.exit(1)
  }
  finalizeSingleDmg(dmg).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
