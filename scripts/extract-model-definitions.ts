#!/usr/bin/env -S npx tsx
/**
 * Extracts MODEL_DEFINITIONS from src/shared/model-catalog.ts and emits one
 * pipe-separated line per model in the format expected by publish-manifest.sh:
 *
 *   id|filename|label|relativePath|archive|checkPath
 *
 * Single source of truth: the TypeScript file. publish-manifest.sh consumes
 * stdin from this script instead of mirroring the catalog in bash. Run this
 * to verify the output:
 *
 *   npx tsx scripts/extract-model-definitions.ts
 */

import { MODEL_DEFINITIONS } from '../src/shared/model-catalog'

for (const m of MODEL_DEFINITIONS) {
  const filename = m.url.split('/').pop()
  if (!filename) {
    console.error(`Model "${m.id}" has invalid URL "${m.url}"`)
    process.exit(1)
  }
  const archive = m.archive ? 'true' : 'false'
  console.log([m.id, filename, m.label, m.relativePath, archive, m.checkPath].join('|'))
}
