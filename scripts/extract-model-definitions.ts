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

/** publish-manifest.sh splits each line on `|` and reads with line-based input.
 * If any field contains `|` or a newline, the bash side silently corrupts the
 * resulting MODELS array. Validate up-front and refuse with a clear error
 * rather than producing a malformed manifest. */
function assertSafe(value: string, fieldName: string, modelId: string): void {
  if (value.includes('|') || /\r|\n/.test(value)) {
    console.error(
      `Model "${modelId}" field "${fieldName}" contains a pipe or newline (value: ${JSON.stringify(value)}). ` +
        `publish-manifest.sh's pipe-delimited parser would corrupt the output. ` +
        `Either rename the field or switch the extractor + bash consumer to JSON.`
    )
    process.exit(1)
  }
}

for (const m of MODEL_DEFINITIONS) {
  const filename = m.url.split('/').pop()
  if (!filename) {
    console.error(`Model "${m.id}" has invalid URL "${m.url}"`)
    process.exit(1)
  }
  const archive = m.archive ? 'true' : 'false'

  assertSafe(m.id, 'id', m.id)
  assertSafe(filename, 'filename', m.id)
  assertSafe(m.label, 'label', m.id)
  assertSafe(m.relativePath, 'relativePath', m.id)
  assertSafe(m.checkPath, 'checkPath', m.id)

  console.log([m.id, filename, m.label, m.relativePath, archive, m.checkPath].join('|'))
}
