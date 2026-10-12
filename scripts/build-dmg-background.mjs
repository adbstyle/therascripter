#!/usr/bin/env node
// Rasterize the DMG window background (build/dmg-background.svg) into the
// 1x/2x PNGs that electron-builder combines into the DMG's .background.tiff.
// Run with: npm run dmg:background
//
// The text uses SF Pro (falls back to Helvetica Neue). Commit the rendered PNGs —
// the build does not render them.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BUILD_DIR = join(ROOT, 'build')
// Inline the logo as a data URI: with resvg-js 2.6 `resourcesDir` silently
// disables `fitTo`, so the @2x render would come out at 1x.
const LOGO_HREF = '../website/assets/logo.svg'
const logoDataUri =
  'data:image/svg+xml;base64,' +
  readFileSync(join(ROOT, 'website', 'assets', 'logo.svg')).toString('base64')
const svgSource = readFileSync(join(BUILD_DIR, 'dmg-background.svg'), 'utf8')
if (!svgSource.includes(LOGO_HREF)) throw new Error(`dmg-background.svg: ${LOGO_HREF} not found`)
const svgBuffer = Buffer.from(svgSource.replace(LOGO_HREF, logoDataUri))

const SIZES = [
  { suffix: '', zoom: 1 },
  { suffix: '@2x', zoom: 2 }
]

for (const { suffix, zoom } of SIZES) {
  const resvg = new Resvg(svgBuffer, {
    fitTo: { mode: 'zoom', value: zoom },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0
  })
  const outPath = join(BUILD_DIR, `dmg-background${suffix}.png`)
  writeFileSync(outPath, resvg.render().asPng())
  console.log(`wrote ${outPath} (${zoom}x)`)
}
