import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODEL_DEFINITIONS, unpublishedRequiredModels } from '../model-catalog'

// Release-Vorbedingung (Review PR #224): kein Pflichtmodell mit published: false
describe('unpublishedRequiredModels', () => {
  const sha = 'a'.repeat(64)

  it('meldet nur Pflichtmodelle, die nicht veröffentlicht sind', () => {
    expect(
      unpublishedRequiredModels([
        { id: 'a', isRequired: true, published: false, sha256: sha },
        { id: 'b', isRequired: true, sha256: sha },
        { id: 'c', isRequired: false, published: false, sha256: sha },
        { id: 'd', isRequired: true, sha256: '0'.repeat(64) }
      ])
    ).toEqual(['a', 'd'])
  })

  it('der echte Katalog hat kein unveröffentlichtes Pflichtmodell (Suchmodell auf R2 seit 2026-11-15)', () => {
    expect(unpublishedRequiredModels(MODEL_DEFINITIONS)).toEqual([])
  })

  it('release.sh prüft die Vorbedingung vor dem Build, mit Übersteuerung nur per Flag', () => {
    const script = readFileSync(join(__dirname, '../../../scripts/release.sh'), 'utf8')
    const check = script.indexOf('scripts/check-unpublished-models.ts')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(script.indexOf('npm run package'))
    expect(script).toContain('--allow-unpublished-models')
  })
})
