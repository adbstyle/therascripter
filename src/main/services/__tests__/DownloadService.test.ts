import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadFile, verifyFileSha256 } from '../DownloadService'

// Tests laufen gegen einen echten lokalen HTTP-Server — die Redirect-,
// Resume- und Abort-Semantik ist genau das, was Mocks nicht beweisen können.

const PAYLOAD = Buffer.from('x'.repeat(10_000))

describe('DownloadService', () => {
  let server: Server
  let baseUrl: string
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'download-test-'))
    server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it('downloads a file and renames .partial to the final path', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    })
    const target = join(dir, 'file.bin')

    const result = await downloadFile(`${baseUrl}/file.bin`, target, () => {})

    expect(result.success).toBe(true)
    expect(readFileSync(target)).toEqual(PAYLOAD)
    expect(existsSync(target + '.partial')).toBe(false)
  })

  it('resumes from an existing .partial via Range request', async () => {
    let receivedRange: string | undefined
    server.on('request', (req, res) => {
      receivedRange = req.headers.range
      const start = parseInt(receivedRange?.replace('bytes=', '').replace('-', '') ?? '0', 10)
      const rest = PAYLOAD.subarray(start)
      res.writeHead(206, { 'content-length': String(rest.length) })
      res.end(rest)
    })
    const target = join(dir, 'file.bin')
    writeFileSync(target + '.partial', PAYLOAD.subarray(0, 4_000))

    const result = await downloadFile(`${baseUrl}/file.bin`, target, () => {})

    expect(result.success).toBe(true)
    expect(receivedRange).toBe('bytes=4000-')
    expect(readFileSync(target)).toEqual(PAYLOAD)
  })

  it('follows an absolute redirect', async () => {
    server.on('request', (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${baseUrl}/real` })
        res.end()
        return
      }
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    })
    const target = join(dir, 'file.bin')

    const result = await downloadFile(`${baseUrl}/redirect`, target, () => {})

    expect(result.success).toBe(true)
    expect(readFileSync(target)).toEqual(PAYLOAD)
  })

  it('follows a relative Location header', async () => {
    server.on('request', (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/real' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    })
    const target = join(dir, 'file.bin')

    const result = await downloadFile(`${baseUrl}/redirect`, target, () => {})

    expect(result.success).toBe(true)
    expect(readFileSync(target)).toEqual(PAYLOAD)
  })

  it('fails cleanly on a redirect loop instead of recursing unboundedly', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(302, { location: `${baseUrl}/loop` })
      res.end()
    })
    const target = join(dir, 'file.bin')

    const result = await downloadFile(`${baseUrl}/loop`, target, () => {})

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/redirect/i)
  })

  it('reports HTTP errors as failure', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const result = await downloadFile(`${baseUrl}/missing`, join(dir, 'f.bin'), () => {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
  })

  it('resolves with failure instead of throwing when the final rename fails', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    })
    // Zielpfad in nicht existierendem Verzeichnis → renameSync wirft ENOENT.
    // Vorher: uncaught exception im finish-Handler, das Promise settlete NIE
    // (startModelDownload hing für immer).
    const target = join(dir, 'missing-subdir', 'file.bin')

    const result = await downloadFile(`${baseUrl}/file.bin`, target, () => {})

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('aborts mid-stream without renaming to the final path', async () => {
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      // Nur die Hälfte senden, dann offen lassen — Abort muss greifen
      res.write(PAYLOAD.subarray(0, 5_000))
    })
    const target = join(dir, 'file.bin')
    const abortSignal = { aborted: false }
    setTimeout(() => {
      abortSignal.aborted = true
    }, 100)

    const result = await downloadFile(`${baseUrl}/file.bin`, target, () => {}, abortSignal)

    expect(result.success).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  describe('verifyFileSha256', () => {
    it('accepts a matching hash and rejects a wrong one', async () => {
      const file = join(dir, 'hashme.bin')
      writeFileSync(file, PAYLOAD)
      const expected = createHash('sha256').update(PAYLOAD).digest('hex')

      await expect(verifyFileSha256(file, expected)).resolves.toBe(true)
      await expect(verifyFileSha256(file, '0'.repeat(64))).resolves.toBe(false)
    })
  })
})
