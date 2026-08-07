import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sweepStaleArtifacts } from '../StartupCleanupService'

describe('sweepStaleArtifacts', () => {
  let base: string
  let stitchDir: string
  let osTmpDir: string
  let dataDir: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'startup-cleanup-test-'))
    stitchDir = join(base, 'therascript-stitch')
    osTmpDir = join(base, 'os-tmp')
    dataDir = join(base, 'data')
    mkdirSync(stitchDir, { recursive: true })
    mkdirSync(osTmpDir, { recursive: true })
    mkdirSync(join(dataDir, 'transcripts'), { recursive: true })
    mkdirSync(join(dataDir, 'models', 'asr'), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('removes stale stitched WAVs (PHI) left behind by a crash', () => {
    const wav = join(stitchDir, 'stitched-123-abc.wav')
    writeFileSync(wav, 'RIFF')
    sweepStaleArtifacts({ stitchDir, osTmpDir, dataDir })
    expect(existsSync(wav)).toBe(false)
  })

  it('removes stale llama prompt files (PHI) from the OS tmpdir', () => {
    const prompt = join(osTmpDir, 'therascript-summary-uuid.txt')
    writeFileSync(prompt, 'Transkript...')
    const unrelated = join(osTmpDir, 'other-app-file.txt')
    writeFileSync(unrelated, 'keep me')
    sweepStaleArtifacts({ stitchDir, osTmpDir, dataDir })
    expect(existsSync(prompt)).toBe(false)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('removes orphaned writeFileAtomic temp files from the data dir', () => {
    const staleTmp = join(dataDir, 'transcripts', 'session-1.json.1234-abcd1234.tmp')
    writeFileSync(staleTmp, '{')
    const real = join(dataDir, 'transcripts', 'session-1.json')
    writeFileSync(real, '{}')
    sweepStaleArtifacts({ stitchDir, osTmpDir, dataDir })
    expect(existsSync(staleTmp)).toBe(false)
    expect(existsSync(real)).toBe(true)
  })

  it('skips the models dir (large, never contains .tmp writes)', () => {
    // Kein Assert auf Traversierung möglich — aber eine .tmp-Datei dort darf
    // NICHT gelöscht werden, weil der Sweep den Teilbaum gar nicht betritt.
    const modelTmp = join(dataDir, 'models', 'asr', 'model.bin.999-deadbeef.tmp')
    writeFileSync(modelTmp, 'x')
    sweepStaleArtifacts({ stitchDir, osTmpDir, dataDir })
    expect(existsSync(modelTmp)).toBe(true)
  })

  it('is a no-op when the dirs do not exist', () => {
    expect(() =>
      sweepStaleArtifacts({
        stitchDir: join(base, 'missing-a'),
        osTmpDir: join(base, 'missing-b'),
        dataDir: join(base, 'missing-c')
      })
    ).not.toThrow()
  })
})
