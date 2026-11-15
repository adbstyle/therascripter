// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest'
import { join } from 'path'
import {
  LineProcess,
  LineProcessExitedError,
  LineProcessRequestError,
  LineProcessTimeoutError,
  type LineProcessOptions
} from '../line-process'

// Lebenszyklus mit echten Prozessen: ein Fake-Dienst (Node-Skript) mit dem
// Protokoll von search_service.py. Nur so lassen sich Kill-Semantik, EOF und
// Pipe-Verhalten belegen.
//
// Lastunabhängig: gewartet wird auf Ereignisse (Start, Exit, pid), nie über
// feste Wartezeiten; Zeitgrenzen sind nur Untergrenzen (Eskalation braucht
// mindestens so lange) oder grosszügige Obergrenzen, deren Abstand zum
// erwarteten Wert jede Rechnerlast überdeckt.

const FAKE = join(__dirname, 'fixtures', 'fake-line-service.mjs')

const running: LineProcess[] = []

function create(env: Record<string, string> = {}, opts: Partial<LineProcessOptions> = {}) {
  const proc = new LineProcess({
    bin: process.execPath,
    args: [FAKE],
    env,
    startTimeoutMs: 20_000,
    eofGraceMs: 500,
    killGraceMs: 500,
    ...opts
  })
  running.push(proc)
  return proc
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const proc of running.splice(0)) {
    proc.kill()
    await proc.waitForExit()
  }
})

describe('LineProcess', { timeout: 30_000 }, () => {
  it('starts, answers requests by id, and records the weights contract line', async () => {
    const proc = create()
    const ready = await proc.start()
    expect(ready).toMatchObject({ ready: true, dim: 768 })
    const [a, b] = await Promise.all([
      proc.request({ op: 'echo', value: 'eins' }),
      proc.request({ op: 'echo', value: 'zwei' })
    ])
    expect(a.echo).toBe('eins')
    expect(b.echo).toBe('zwei')
    expect(proc.weightsLine).toBe('torch.float32 auf cpu')
    expect(proc.stderr).toContain('Suchmodell geladen')
  })

  it('passes only the whitelist env plus explicit variables', async () => {
    process.env.THERASCRIPT_LEAK_TEST = 'geheim'
    try {
      const proc = create({ HF_HUB_OFFLINE: '1' })
      await proc.start()
      const res = (await proc.request({ op: 'env' })) as { env: Record<string, string> }
      expect(res.env.HF_HUB_OFFLINE).toBe('1')
      expect(res.env.THERASCRIPT_LEAK_TEST).toBeUndefined()
      expect(res.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
    } finally {
      delete process.env.THERASCRIPT_LEAK_TEST
    }
  })

  it('rejects a service error with code and keeps the process alive', async () => {
    const proc = create()
    await proc.start()
    const err = await proc
      .request({ op: 'fail', code: 'bad_request', message: 'kaputt' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LineProcessRequestError)
    expect((err as LineProcessRequestError).code).toBe('bad_request')
    expect((await proc.request({ op: 'echo', value: 1 })).echo).toBe(1)
  })

  it('maps an id:null error to the oldest open request (FIFO)', async () => {
    const proc = create()
    await proc.start()
    const first = proc.request({ op: 'sleep', ms: 50 })
    const second = proc.request({ op: 'nullid' })
    const third = proc.request({ op: 'echo', value: 'c' })
    await expect(first).resolves.toMatchObject({ slept: 50 })
    const err = await second.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LineProcessRequestError)
    expect((err as LineProcessRequestError).code).toBe('too_large')
    await expect(third).resolves.toMatchObject({ echo: 'c' })
  })

  it('ignores garbage lines on stdout', async () => {
    const proc = create()
    await proc.start()
    await expect(proc.request({ op: 'garbage' })).resolves.toMatchObject({ ok: true })
  })

  it('times out a single request without killing the process; the late answer is dropped', async () => {
    const proc = create()
    await proc.start()
    // Antwort erst nach 2 s — die Frist von 50 ms läuft sicher vorher ab
    const err = await proc.request({ op: 'sleep', ms: 2_000 }, { timeoutMs: 50 }).catch((e) => e)
    expect(err).toBeInstanceOf(LineProcessTimeoutError)
    // Die späte Antwort (id der abgelaufenen Anfrage) wird verworfen
    await expect(proc.request({ op: 'echo', value: 'x' })).resolves.toMatchObject({ echo: 'x' })
    expect(proc.exited).toBeNull()
  })

  it('rejects all open requests when the process crashes', async () => {
    const proc = create()
    await proc.start()
    const slow = proc.request({ op: 'sleep', ms: 200 })
    const crash = proc.request({ op: 'crash', code: 3 })
    // crash wird erst nach sleep bearbeitet — deshalb direkt beenden lassen
    const results = await Promise.allSettled([slow, crash, proc.waitForExit()])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    const exit = await proc.waitForExit()
    expect(exit.code).toBe(3)
    expect(exit.stopRequested).toBe(false)
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(LineProcessExitedError)
    await expect(proc.request({ op: 'echo' })).rejects.toBeInstanceOf(LineProcessExitedError)
  })

  it('reports an external SIGKILL as exitSignal', async () => {
    const proc = create()
    await proc.start()
    const pending = proc.request({ op: 'selfkill' })
    await expect(pending).rejects.toBeInstanceOf(LineProcessExitedError)
    const exit = await proc.waitForExit()
    expect(exit.exitSignal).toBe('SIGKILL')
    expect(exit.stopRequested).toBe(false)
  })

  it('stop() closes stdin and the service exits by itself (EOF → exit 0)', async () => {
    const proc = create()
    await proc.start()
    const pid = proc.pid
    const exit = await proc.stop()
    expect(exit.code).toBe(0)
    // Ohne Signal beendet: der Dienst ging von selbst, bevor eskaliert wurde
    expect(exit.exitSignal).toBeNull()
    expect(exit.stopRequested).toBe(true)
    expect(alive(pid)).toBe(false)
    // idempotent
    await expect(proc.stop()).resolves.toBe(exit)
  })

  it('escalates EOF → SIGTERM when the service ignores EOF', async () => {
    const proc = create({ FAKE_IGNORE_EOF: '1' })
    await proc.start()
    const exit = await proc.stop()
    expect(exit.exitSignal).toBe('SIGTERM')
  })

  it('escalates to SIGKILL when the service ignores EOF and SIGTERM', async () => {
    const proc = create({ FAKE_IGNORE_EOF: '1', FAKE_IGNORE_SIGTERM: '1' })
    await proc.start()
    const pid = proc.pid
    const started = Date.now()
    const exit = await proc.stop()
    expect(exit.exitSignal).toBe('SIGKILL')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(alive(pid)).toBe(false)
  })

  it('stop() during startup ends the process and rejects start()', async () => {
    // Die Startzeile kommt erst nach 30 s — der Stopp fällt sicher in den Start
    const proc = create({ FAKE_READY_DELAY_MS: '30000' })
    const start = proc.start()
    await vi.waitFor(() => expect(proc.pid).toBeDefined(), { timeout: 10_000 })
    const exit = await proc.stop()
    expect(exit.stopRequested).toBe(true)
    await expect(start).rejects.toBeInstanceOf(LineProcessExitedError)
  })

  it('kills the process when the ready line does not arrive in time', async () => {
    const proc = create({ FAKE_NO_READY: '1' }, { startTimeoutMs: 200 })
    const err = await proc.start().catch((e) => e)
    expect(err).toBeInstanceOf(LineProcessExitedError)
    expect((err as LineProcessExitedError).exit.startTimedOut).toBe(true)
    expect(String(err.message)).toContain('Startzeile')
  })

  it('rejects start() with exit code and stderr when the service dies before ready', async () => {
    const proc = create({ FAKE_EXIT_BEFORE_READY: '2' })
    const err = await proc.start().catch((e) => e)
    expect(err).toBeInstanceOf(LineProcessExitedError)
    expect((err as LineProcessExitedError).exit.code).toBe(2)
    expect(String(err.message)).toContain('Suchmodell konnte nicht geladen werden')
  })

  it('drops a half last line at exit and rejects the open request', async () => {
    const proc = create()
    await proc.start()
    await expect(proc.request({ op: 'half' })).rejects.toBeInstanceOf(LineProcessExitedError)
    expect((await proc.waitForExit()).code).toBe(0)
  })

  it('handles very large responses across many chunks (incl. multibyte at the end)', async () => {
    const proc = create()
    await proc.start()
    const res = (await proc.request({ op: 'big', bytes: 12 * 1024 * 1024 })) as {
      data: string
      tail: string
    }
    expect(res.data.length).toBe(12 * 1024 * 1024)
    expect(res.tail).toBe('Ende ä')
  })

  it('rejects requests before start and after exit', async () => {
    const proc = create()
    await expect(proc.request({ op: 'ping' })).rejects.toThrow('nicht bereit')
    await proc.start()
    await proc.stop()
    await expect(proc.request({ op: 'ping' })).rejects.toBeInstanceOf(LineProcessExitedError)
  })

  it('treats exit without close as ended after SIGKILL + settle time (grandchild holds the pipes)', async () => {
    const proc = create(
      { FAKE_IGNORE_EOF: '1', FAKE_IGNORE_SIGTERM: '1' },
      { eofGraceMs: 100, killGraceMs: 100, killSettleMs: 300 }
    )
    await proc.start()
    const { holderPid } = (await proc.request({ op: 'spawn-holder' })) as { holderPid: number }
    try {
      const started = Date.now()
      const exit = await proc.stop()
      // Erst nach dem SIGKILL weiter, aber mit harter Obergrenze
      expect(exit.exitSignal).toBe('SIGKILL')
      expect(Date.now() - started).toBeGreaterThanOrEqual(200)
      // Obergrenze: endet überhaupt (ohne Settle-Zeit hinge stop() an den Pipes)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(alive(proc.pid)).toBe(false)
    } finally {
      try {
        process.kill(holderPid, 'SIGKILL')
      } catch {
        // schon weg
      }
    }
  })

  it('stop() accepts shorter escalation times (quit)', async () => {
    // Voreinstellung 2 × 5 s; die kurzen Zeiten (150 ms) liegen weit darunter
    const proc = create(
      { FAKE_IGNORE_EOF: '1', FAKE_IGNORE_SIGTERM: '1' },
      { eofGraceMs: 5_000, killGraceMs: 5_000 }
    )
    await proc.start()
    const started = Date.now()
    const exit = await proc.stop({ eofGraceMs: 50, killGraceMs: 100 })
    expect(exit.exitSignal).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
