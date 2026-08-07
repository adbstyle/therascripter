import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileAtomic } from '../file-ops'

describe('writeFileAtomic', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'file-ops-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the content to the target path', () => {
    const target = join(dir, 'doc.json')
    writeFileAtomic(target, '{"a":1}')
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}')
  })

  it('leaves no temp file behind after a successful write', () => {
    const target = join(dir, 'doc.json')
    writeFileAtomic(target, 'content')
    expect(readdirSync(dir)).toEqual(['doc.json'])
  })

  it('overwrites an existing file completely', () => {
    const target = join(dir, 'doc.json')
    writeFileSync(target, 'old-content-that-is-longer')
    writeFileAtomic(target, 'new')
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })

  it('uses a unique temp suffix so two writers to the same path cannot clobber each other', async () => {
    // Der alte fixe `.tmp`-Suffix hieß: Writer B überschreibt Writer As halb
    // geschriebene tmp-Datei. Beweis über die Namensfunktion: mehrere
    // Aufrufe dürfen nie denselben tmp-Pfad liefern.
    const { tmpPathFor } = await import('../file-ops')
    const target = join(dir, 'doc.json')
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const tmp = tmpPathFor(target)
      expect(tmp.startsWith(target + '.')).toBe(true)
      expect(seen.has(tmp)).toBe(false)
      seen.add(tmp)
    }
  })

  it('creates missing parent directories', () => {
    const target = join(dir, 'nested', 'deep', 'doc.json')
    writeFileAtomic(target, 'x')
    expect(readFileSync(target, 'utf-8')).toBe('x')
  })
})
