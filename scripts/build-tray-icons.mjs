#!/usr/bin/env node
/* global console */
// Rasterize tray SVG sources into macOS template-image PNGs.
// Run with: npm run icons:tray

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC_DIR = join(ROOT, 'resources', 'icons-src')
const OUT_DIR = join(ROOT, 'resources', 'icons')

const TARGETS = [
  { svg: 'tray-idle.svg', basename: 'TrayIconTemplate' },
  { svg: 'tray-recording.svg', basename: 'TrayIconRecordingTemplate' }
]

const SIZES = [
  { suffix: '', width: 16 },
  { suffix: '@2x', width: 32 }
]

mkdirSync(OUT_DIR, { recursive: true })

for (const { svg, basename } of TARGETS) {
  const svgBuffer = readFileSync(join(SRC_DIR, svg))
  for (const { suffix, width } of SIZES) {
    const resvg = new Resvg(svgBuffer, {
      fitTo: { mode: 'width', value: width },
      background: 'rgba(0, 0, 0, 0)',
      shapeRendering: 2,
      textRendering: 1,
      imageRendering: 0
    })
    const png = resvg.render().asPng()
    const outPath = join(OUT_DIR, `${basename}${suffix}.png`)
    writeFileSync(outPath, png)
    console.log(`wrote ${outPath} (${width}x${width})`)
  }
}
