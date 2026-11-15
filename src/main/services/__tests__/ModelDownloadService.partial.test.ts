import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Echter Download über einen lokalen HTTP-Server, echtes Dateisystem (Review PR #224)
const { dataDir } = vi.hoisted(() => ({ dataDir: { value: '' } }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../db/connection', () => ({ getDataDir: () => dataDir.value }))
vi.mock('../SettingsService', () => ({
  getSettings: () => ({ get: () => undefined, set: () => {} })
}))
vi.mock('../InstalledVersionsStore', () => ({
  setInstalledVersion: vi.fn(),
  deleteInstalledVersion: vi.fn()
}))

import type { ModelDefinition } from '../../../shared/model-catalog'
import { installCatalogModel } from '../ModelDownloadService'

const PAYLOAD = Buffer.alloc(10_000, 7)
type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let baseUrl: string
let handler: Handler
const ranges: Array<string | undefined> = []

function def(): ModelDefinition {
  return {
    id: 'flat',
    label: 'Flat',
    url: `${baseUrl}/flat.bin`,
    sizeBytes: PAYLOAD.length,
    sha256: createHash('sha256').update(PAYLOAD).digest('hex'),
    relativePath: 'x/flat.bin',
    checkPath: 'x/flat.bin',
    group: 'search'
  }
}
const target = (): string => join(dataDir.value, 'models', 'x', 'flat.bin')
const partial = (): string => `${target()}.partial`
const signal = { aborted: false }

/** Antwortet wie R2: Range → 206 mit dem Rest, ohne Range → 200. */
const r2: Handler = (req, res) => {
  const range = req.headers.range
  if (range) {
    const start = parseInt(range.replace('bytes=', ''), 10)
    if (start >= PAYLOAD.length) {
      res.writeHead(416)
      res.end()
      return
    }
    const rest = PAYLOAD.subarray(start)
    res.writeHead(206, { 'content-length': String(rest.length) })
    res.end(rest)
    return
  }
  res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
  res.end(PAYLOAD)
}

beforeEach(async () => {
  dataDir.value = mkdtempSync(join(tmpdir(), 'mds-partial-'))
  mkdirSync(join(dataDir.value, 'models', 'x'), { recursive: true })
  ranges.length = 0
  handler = r2
  server = createServer((req, res) => {
    ranges.push(req.headers.range)
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(dataDir.value, { recursive: true, force: true })
})

describe('installCatalogModel — .partial und Serverantworten', () => {
  it('206: setzt eine angefangene .partial fort', async () => {
    writeFileSync(partial(), PAYLOAD.subarray(0, 4_000))
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(ranges).toEqual(['bytes=4000-'])
    expect(readFileSync(target())).toEqual(PAYLOAD)
  })

  it('200 statt 206: lädt von vorn und bleibt korrekt', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    }
    writeFileSync(partial(), PAYLOAD.subarray(0, 4_000))
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(readFileSync(target())).toEqual(PAYLOAD)
  })

  it('vollständige .partial: geprüft und übernommen, kein Request (keine 416-Schleife)', async () => {
    writeFileSync(partial(), PAYLOAD)
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(ranges).toEqual([])
    expect(existsSync(partial())).toBe(false)
  })

  it('zu grosse oder kaputte volle .partial: verworfen, neu ohne Range', async () => {
    writeFileSync(partial(), Buffer.alloc(PAYLOAD.length + 5, 1))
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(ranges).toEqual([undefined])
    writeFileSync(partial(), Buffer.alloc(PAYLOAD.length, 1))
    rmSync(target())
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(ranges).toEqual([undefined, undefined])
  })

  it('416 auf den Range-Request: .partial weg, einmal neu ohne Range', async () => {
    let first = true
    handler = (req, res) => {
      if (req.headers.range && first) {
        first = false
        res.writeHead(416)
        res.end()
        return
      }
      r2(req, res)
    }
    writeFileSync(partial(), PAYLOAD.subarray(0, 4_000))
    expect(await installCatalogModel(def(), { signal })).toEqual({ ok: true, installed: true })
    expect(ranges).toEqual(['bytes=4000-', undefined])
    expect(readFileSync(target())).toEqual(PAYLOAD)
  })

  it.each([404, 500])('HTTP %s: Grund server, nicht network', async (status) => {
    handler = (_req, res) => {
      res.writeHead(status)
      res.end()
    }
    expect(await installCatalogModel(def(), { signal })).toEqual({
      ok: false,
      reason: 'server',
      error: `HTTP ${status}`
    })
  })

  it('Server nicht erreichbar: Grund network', async () => {
    const d = { ...def(), url: 'http://127.0.0.1:1/flat.bin' }
    expect(await installCatalogModel(d, { signal })).toMatchObject({ ok: false, reason: 'network' })
  })
})
