import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ToolHealthService,
  isApprovedQuarantine,
  setToolHealthService,
  throwIfToolBlocked,
  type RunResult,
  type ToolHealthDeps
} from '../ToolHealthService'
import { ToolBlockedError, isToolBlockedMessage } from '../../../shared/tool-blocked'

const APPROVED = '03c1;6720a000;Safari;ABC'
const UNAPPROVED = '0083;6720a000;Safari;ABC'

/** Kleines Dateisystem nur aus Markierung und Schreibrecht — wie find/xattr/chmod es sehen. */
interface FakeFile {
  quarantine: string | null
  writable: boolean
}

let resources: string
let files: Map<string, FakeFile>
let mainMark: string | null
let calls: string[]

function fakeRun(bin: string, args: string[]): Promise<RunResult> {
  calls.push(`${bin.split('/').pop()} ${args[0]}`)
  const ok = (stdout = ''): Promise<RunResult> => Promise.resolve({ code: 0, stdout, stderr: '' })
  if (bin === '/usr/bin/find') {
    const dirs = args.slice(0, args.indexOf('-type'))
    const found = [...files.keys()].filter((f) => dirs.some((d) => f.startsWith(`${d}/`)))
    return ok(found.map((f) => `${f}\0`).join(''))
  }
  if (bin === '/usr/bin/xattr' && args[0] === '-p') {
    const targets = args.slice(2)
    const mark = (f: string): string | null =>
      f.endsWith('MacOS/Therascript') ? mainMark : (files.get(f)?.quarantine ?? null)
    if (targets.length === 1) {
      const m = mark(targets[0])
      return Promise.resolve({ code: m ? 0 : 1, stdout: m ? `${m}\n` : '', stderr: '' })
    }
    const lines = targets.filter((f) => mark(f)).map((f) => `${f}: ${mark(f)}`)
    return ok(lines.join('\n'))
  }
  if (bin === '/bin/chmod') {
    for (const f of args.slice(1)) files.get(f)!.writable = true
    return ok()
  }
  if (bin === '/usr/bin/xattr' && args[0] === '-d') {
    for (const f of args.slice(2)) {
      const file = files.get(f)!
      // Wie xattr: ohne Schreibrecht «Permission denied»
      if (file.writable) file.quarantine = null
    }
    return ok()
  }
  throw new Error(`unerwartet: ${bin}`)
}

function deps(over: Partial<ToolHealthDeps> = {}): ToolHealthDeps & {
  onStateChange: ReturnType<typeof vi.fn>
} {
  return {
    isPackaged: true,
    resourcesPath: resources,
    bundlePath: '/Applications/Therascript.app',
    mainExecutable: '/Applications/Therascript.app/Contents/MacOS/Therascript',
    run: fakeRun,
    onStateChange: vi.fn(),
    log: () => undefined,
    ...over
  } as ToolHealthDeps & { onStateChange: ReturnType<typeof vi.fn> }
}

function addFile(rel: string, quarantine: string | null, writable = true): string {
  const path = join(resources, rel)
  files.set(path, { quarantine, writable })
  return path
}

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), 'tool-health-'))
  for (const dir of ['whisper', 'llama', 'bin', 'ml_sidecar']) mkdirSync(join(resources, dir))
  files = new Map()
  mainMark = APPROVED
  calls = []
  // Nach «Dennoch öffnen»: alles freigegeben …
  addFile('whisper/bin/whisper-cli', APPROVED)
  addFile('llama/bin/llama-cli', APPROVED)
  addFile('bin/vision-ocr', APPROVED)
  addFile('ml_sidecar/standalone/bin/python3', APPROVED)
  setToolHealthService(null)
})

describe('isApprovedQuarantine', () => {
  it('erkennt die Freigabe am Flag 0x40', () => {
    expect(isApprovedQuarantine(APPROVED)).toBe(true)
    expect(isApprovedQuarantine('00c1;x')).toBe(true)
    expect(isApprovedQuarantine(UNAPPROVED)).toBe(false)
    expect(isApprovedQuarantine(null)).toBe(true)
  })
})

describe('ToolHealthService (#168)', () => {
  it('meldet ok, wenn alle Programmdateien freigegeben sind', async () => {
    const service = new ToolHealthService(deps())
    await service.check()
    expect(service.getState()).toMatchObject({ status: 'ok', tools: [] })
    expect(calls).not.toContain('chmod u+w')
  })

  it('behebt eine schreibgeschützte, nicht freigegebene Datei still, wenn die App freigegeben ist (AK 1)', async () => {
    // … ausser einer schreibgeschützten Bibliothek, die ihre alte Markierung behielt
    const lib = addFile('llama/lib/libggml.0.dylib', UNAPPROVED, false)
    const service = new ToolHealthService(deps())
    await service.check()
    expect(service.getState()).toMatchObject({ status: 'ok', tools: [] })
    expect(files.get(lib)).toEqual({ quarantine: null, writable: true })
  })

  it('repariert nie ohne Programm-Freigabe der App (Out of Scope 1)', async () => {
    mainMark = UNAPPROVED
    const lib = addFile('whisper/lib/libwhisper.dylib', UNAPPROVED, false)
    const service = new ToolHealthService(deps())
    await service.check()
    expect(service.getState()).toMatchObject({ status: 'blocked', tools: ['whisper'] })
    expect(files.get(lib)?.quarantine).toBe(UNAPPROVED)
    expect(calls).not.toContain('chmod u+w')
  })

  it('meldet, was sich nicht beheben lässt, mit den betroffenen Werkzeugen (AK 2, AK 5)', async () => {
    addFile('ml_sidecar/standalone/lib/torch/_C.so', UNAPPROVED, false)
    addFile('bin/vision-ocr-helper', UNAPPROVED, false)
    const service = new ToolHealthService(
      deps({
        // chmod scheitert (z. B. App gehört einem anderen Benutzer)
        run: (bin, args) =>
          bin === '/bin/chmod'
            ? Promise.resolve({ code: 1, stdout: '', stderr: 'Operation not permitted' })
            : fakeRun(bin, args)
      })
    )
    await service.check()
    expect(service.getState()).toMatchObject({ status: 'blocked', tools: ['python', 'ocr'] })
  })

  it('prüft in der Entwicklungsversion nichts', async () => {
    const service = new ToolHealthService(deps({ isPackaged: false }))
    await service.check()
    expect(service.getState().status).toBe('ok')
    expect(calls).toEqual([])
  })

  it('behandelt ein einzelnes Ergebnis von xattr (ohne Pfad-Präfix) richtig', async () => {
    files.clear()
    addFile('bin/vision-ocr', UNAPPROVED, false)
    mainMark = UNAPPROVED
    const service = new ToolHealthService(deps())
    await service.check()
    expect(service.getState().tools).toEqual(['ocr'])
  })
})

describe('throwIfToolBlocked — Fehler unterwegs (#168 PC 1)', () => {
  const killed = { signal: 'SIGKILL' as const, timedOut: false, aborted: false }

  it('lässt andere Gründe durch (kein SIGKILL, eigener Timeout/Abbruch)', async () => {
    setToolHealthService(new ToolHealthService(deps()))
    await expect(
      throwIfToolBlocked('whisper', { signal: null, timedOut: false, aborted: false })
    ).resolves.toBeUndefined()
    await expect(
      throwIfToolBlocked('whisper', { ...killed, timedOut: true })
    ).resolves.toBeUndefined()
  })

  it('ein SIGKILL ohne Blockade (z. B. Speichermangel) bleibt ein normaler Fehler', async () => {
    setToolHealthService(new ToolHealthService(deps()))
    await expect(throwIfToolBlocked('python', killed)).resolves.toBeUndefined()
  })

  it('meldet eine behobene Blockade verständlich — ein erneuter Versuch genügt', async () => {
    addFile('whisper/lib/libggml.0.dylib', UNAPPROVED, false)
    setToolHealthService(new ToolHealthService(deps()))
    const err = await throwIfToolBlocked('whisper', killed).catch((e) => e)
    expect(err).toBeInstanceOf(ToolBlockedError)
    expect(err.repaired).toBe(true)
    expect(isToolBlockedMessage(err.message)).toBe(true)
    expect(err.message).toMatch(/Transkription.*behoben/)
  })

  it('meldet eine bleibende Blockade und verweist auf den Hinweis', async () => {
    mainMark = UNAPPROVED
    addFile('llama/bin/libggml-metal.so', UNAPPROVED, false)
    const service = new ToolHealthService(deps())
    setToolHealthService(service)
    const err = await throwIfToolBlocked('llama', killed).catch((e) => e)
    expect(err).toMatchObject({ tool: 'llama', repaired: false })
    expect(err.message).toMatch(/Zusammenfassung.*Hinweis/)
    expect(service.getState()).toMatchObject({ status: 'blocked', tools: ['llama'] })
  })
})
