import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertNoEscapingLinks,
  isModelStaged,
  modelsSwappedIn,
  rollbackModels,
  stageModel,
  stagePaths,
  swapModelsIn,
  type StageIo
} from '../model-staging'
import type { BundleModel } from '../../../shared/validation/model-update-schemas'

const SHA = 'a'.repeat(64)
let modelsDir: string

const model = (over: Partial<BundleModel> & { id: string }): BundleModel => ({
  version: '2026-10-12',
  label: over.id,
  url: `https://cdn/${over.id}`,
  sha256: SHA,
  sizeBytes: 3,
  relativePath: over.id,
  checkPath: `${over.id}/model`,
  archive: true,
  required: true,
  kind: 'update',
  ...over
})

/** Bereitgestelltes Modell anlegen, als hätte stageModel es fertig. */
function staged(m: BundleModel, content = 'new'): void {
  const { payload } = stagePaths(modelsDir, m)
  if (m.archive) {
    mkdirSync(payload, { recursive: true })
    writeFileSync(join(payload, 'model'), content)
  } else {
    mkdirSync(join(payload, '..'), { recursive: true })
    writeFileSync(payload, content)
  }
}

function installed(m: BundleModel, content = 'old'): void {
  mkdirSync(join(modelsDir, m.relativePath), { recursive: true })
  writeFileSync(join(modelsDir, m.relativePath, 'model'), content)
}

const read = (m: BundleModel): string => readFileSync(join(modelsDir, m.checkPath), 'utf8')

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), 'model-staging-'))
})

afterEach(() => {
  rmSync(modelsDir, { recursive: true, force: true })
})

describe('stageModel', () => {
  const io = (over: Partial<StageIo> = {}): StageIo => ({
    download: vi.fn(async (_url, target: string) => {
      writeFileSync(target, 'tgz')
      return { success: true, sha256: SHA }
    }),
    sha256OfFile: async () => SHA,
    extractTarGz: async (_archive, target) => {
      writeFileSync(join(target, 'model'), 'new')
    },
    ...over
  })
  const signal = new AbortController().signal

  it('lädt, prüft und entpackt ein Archiv bis zum fertigen payload', async () => {
    const m = model({ id: 'ner' })
    await stageModel(modelsDir, m, io(), () => undefined, signal)
    expect(isModelStaged(modelsDir, m)).toBe(true)
    expect(existsSync(stagePaths(modelsDir, m).artifact)).toBe(false)
  })

  it('übernimmt eine einzelne Datei unverändert', async () => {
    const m = model({
      id: 'asr',
      archive: false,
      relativePath: 'asr/a.bin',
      checkPath: 'asr/a.bin'
    })
    await stageModel(modelsDir, m, io(), () => undefined, signal)
    expect(readFileSync(stagePaths(modelsDir, m).payload, 'utf8')).toBe('tgz')
  })

  it('verwirft eine Datei, die nicht zur signierten Beschreibung passt', async () => {
    const m = model({ id: 'ner' })
    const bad = io({
      download: async (_u, t) => (writeFileSync(t, 'x'), { success: true, sha256: 'b'.repeat(64) })
    })
    await expect(stageModel(modelsDir, m, bad, () => undefined, signal)).rejects.toThrow(
      /signierten/
    )
    expect(existsSync(stagePaths(modelsDir, m).artifact)).toBe(false)
    expect(isModelStaged(modelsDir, m)).toBe(false)
  })

  it('setzt mit einer schon geladenen Datei fort, statt neu zu laden', async () => {
    const m = model({ id: 'ner' })
    mkdirSync(stagePaths(modelsDir, m).dir, { recursive: true })
    writeFileSync(stagePaths(modelsDir, m).artifact, 'tgz')
    const deps = io()
    await stageModel(modelsDir, m, deps, () => undefined, signal)
    expect(deps.download).not.toHaveBeenCalled()
    expect(isModelStaged(modelsDir, m)).toBe(true)
  })

  it('verlangt den Prüfpfad im Archiv', async () => {
    const m = model({ id: 'ner', checkPath: 'ner/fehlt' })
    await expect(stageModel(modelsDir, m, io(), () => undefined, signal)).rejects.toThrow(/fehlt/)
    expect(isModelStaged(modelsDir, m)).toBe(false)
  })

  it('weist Archive mit Verknüpfungen nach ausserhalb ab', async () => {
    const m = model({ id: 'ner' })
    const evil = io({
      extractTarGz: async (_a, target) => {
        writeFileSync(join(target, 'model'), 'new')
        symlinkSync('/etc', join(target, 'link'))
      }
    })
    await expect(stageModel(modelsDir, m, evil, () => undefined, signal)).rejects.toThrow(
      /ausserhalb/
    )
  })

  it('erlaubt Verknüpfungen innerhalb des Archivs (HuggingFace-Cache)', () => {
    const root = join(modelsDir, 'tree')
    mkdirSync(join(root, 'blobs'), { recursive: true })
    mkdirSync(join(root, 'snapshots'))
    writeFileSync(join(root, 'blobs', 'abc'), 'x')
    symlinkSync('../blobs/abc', join(root, 'snapshots', 'model'))
    expect(() => assertNoEscapingLinks(root)).not.toThrow()
  })
})

describe('Austausch — alles oder nichts', () => {
  const ner = model({ id: 'ner' })
  const vad = model({ id: 'vad', sha256: 'b'.repeat(64), kind: 'new' })
  const asr = model({
    id: 'asr',
    sha256: 'c'.repeat(64),
    archive: false,
    relativePath: 'asr/a.bin',
    checkPath: 'asr/a.bin'
  })
  const all = [ner, vad, asr]

  beforeEach(() => {
    installed(ner)
    mkdirSync(join(modelsDir, 'asr'))
    writeFileSync(join(modelsDir, 'asr', 'a.bin'), 'old')
    for (const m of all) staged(m)
  })

  it('tauscht alle Modelle ein und legt die bisherigen beiseite', () => {
    swapModelsIn(modelsDir, all)
    expect(all.map(read)).toEqual(['new', 'new', 'new'])
    expect(modelsSwappedIn(modelsDir, all)).toBe(true)
    expect(existsSync(stagePaths(modelsDir, ner).backup)).toBe(true)
  })

  it.each([0, 1, 2, 3, 4])('scheitert der %i. Schritt, ist danach alles wie vorher', (failAt) => {
    let calls = 0
    const rename = (from: string, to: string): void => {
      if (calls++ === failAt) throw new Error('Platte voll')
      renameSync(from, to)
    }
    expect(() => swapModelsIn(modelsDir, all, rename)).toThrow('Platte voll')
    expect(read(ner)).toBe('old')
    expect(readFileSync(join(modelsDir, 'asr', 'a.bin'), 'utf8')).toBe('old')
    expect(existsSync(join(modelsDir, 'vad'))).toBe(false)
    expect(all.every((m) => isModelStaged(modelsDir, m))).toBe(true)
  })

  it.each([0, 1, 2, 3, 4, 5])(
    'nach einem Absturz nach %i Schritten stellt das Zurücktauschen den alten Stand her — auch zweimal',
    (steps) => {
      let calls = 0
      const crash = (from: string, to: string): void => {
        if (calls++ >= steps) throw new Error('Absturz')
        renameSync(from, to)
      }
      // Absturz simulieren: kein Rücktausch im selben Prozess
      try {
        for (const m of all) {
          const p = stagePaths(modelsDir, m)
          mkdirSync(join(p.backup, '..'), { recursive: true })
          if (existsSync(p.final)) crash(p.final, p.backup)
          crash(p.payload, p.final)
        }
      } catch {
        /* Absturz */
      }
      rollbackModels(modelsDir, all)
      rollbackModels(modelsDir, all)
      expect(read(ner)).toBe('old')
      expect(readFileSync(join(modelsDir, 'asr', 'a.bin'), 'utf8')).toBe('old')
      expect(existsSync(join(modelsDir, 'vad'))).toBe(false)
      expect(all.every((m) => isModelStaged(modelsDir, m))).toBe(true)
      expect(modelsSwappedIn(modelsDir, all)).toBe(false)
    }
  )
})
