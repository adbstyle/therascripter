import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const home = vi.hoisted(() => ({ path: '/mock/home' }))
vi.mock('electron', () => ({
  app: { getPath: () => home.path }
}))

import {
  ensureSpotlightExclusion,
  sweepOrphanedSessionFiles,
  sweepStaleArtifacts,
  SESSION_FILE_DIRS
} from '../StartupCleanupService'

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

describe('sweepOrphanedSessionFiles (Issue #202)', () => {
  const KNOWN = '11111111-2222-4333-8444-555555555555'
  const GONE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'orphan-sweep-test-'))
    for (const dir of SESSION_FILE_DIRS) mkdirSync(join(dataDir, dir))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  function put(dir: string, name: string): string {
    const full = join(dataDir, dir, name)
    writeFileSync(full, 'PHI')
    return full
  }

  it('removes every file of a session that no longer exists in the database', () => {
    const orphans = [
      put('audio', `${GONE}.wav`),
      put('transcripts', `${GONE}.json`),
      put('transcripts', `${GONE}-aligned.json`),
      put('diarization', `${GONE}.json`),
      put('anonymized', `${GONE}.json`),
      put('pdf', `${GONE}.pdf`),
      put('extracted', `${GONE}.json`),
      put('recovery', `${GONE}.pcm`)
    ]

    const removed = sweepOrphanedSessionFiles(dataDir, new Set([KNOWN]))

    expect(removed).toBe(orphans.length)
    for (const file of orphans) expect(existsSync(file)).toBe(false)
  })

  it('keeps the files of existing sessions (case-insensitive id match)', () => {
    const kept = [
      put('audio', `${KNOWN}.wav`),
      put('transcripts', `${KNOWN}-aligned.json`),
      put('anonymized', `${KNOWN.toUpperCase()}.json`)
    ]

    expect(sweepOrphanedSessionFiles(dataDir, new Set([KNOWN]))).toBe(0)
    for (const file of kept) expect(existsSync(file)).toBe(true)
  })

  it('leaves files alone whose name does not follow the session pattern', () => {
    const foreign = [
      put('audio', 'notes.txt'),
      put('pdf', 'Arztbericht.pdf'),
      put('transcripts', `${GONE}.json.1234-abcd.tmp`),
      put('transcripts', `prefix-${GONE}.json`),
      put('audio', '.DS_Store')
    ]

    expect(sweepOrphanedSessionFiles(dataDir, new Set())).toBe(0)
    for (const file of foreign) expect(existsSync(file)).toBe(true)
  })

  it('does not descend into or remove directories', () => {
    mkdirSync(join(dataDir, 'audio', GONE + '.wav'))

    expect(sweepOrphanedSessionFiles(dataDir, new Set())).toBe(0)
    expect(statSync(join(dataDir, 'audio', GONE + '.wav')).isDirectory()).toBe(true)
  })

  it('tolerates missing session dirs', () => {
    rmSync(join(dataDir, 'recovery'), { recursive: true })
    put('audio', `${GONE}.wav`)

    expect(sweepOrphanedSessionFiles(dataDir, new Set())).toBe(1)
  })
})

describe('ensureSpotlightExclusion', () => {
  beforeEach(() => {
    home.path = mkdtempSync(join(tmpdir(), 'spotlight-test-'))
    mkdirSync(join(home.path, '.therascript'))
  })

  afterEach(() => {
    rmSync(home.path, { recursive: true, force: true })
  })

  it('creates .metadata_never_index with mode 0600 if not present', () => {
    ensureSpotlightExclusion()

    const marker = join(home.path, '.therascript', '.metadata_never_index')
    expect(existsSync(marker)).toBe(true)
    expect(statSync(marker).mode & 0o777).toBe(0o600)
  })

  it('leaves an existing marker untouched', () => {
    const marker = join(home.path, '.therascript', '.metadata_never_index')
    writeFileSync(marker, 'existing')

    ensureSpotlightExclusion()

    expect(statSync(marker).size).toBe('existing'.length)
  })
})
