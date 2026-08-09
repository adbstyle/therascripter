import { describe, it, expect } from 'vitest'
import { buildSubprocessEnv, runSubprocess } from '../subprocess'

// Lifecycle tests use real short-lived processes (sh/sleep) — the whole point
// is to verify actual kill semantics (SIGTERM → grace → SIGKILL), which mocks
// cannot prove.

describe('runSubprocess', () => {
  it('resolves with stdout and exit code 0 on normal exit', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf hello']
    })
    expect(result.stdout).toBe('hello')
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('resolves (not rejects) on non-zero exit and reports the code', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'exit 3']
    })
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('captures stderr', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf err-output >&2']
    })
    expect(result.stderr).toBe('err-output')
  })

  it('kills the process on timeout and resolves with timedOut=true', async () => {
    const start = Date.now()
    const result = await runSubprocess({
      bin: '/bin/sleep',
      args: ['30'],
      timeoutMs: 200
    })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull() // killed by signal, no exit code
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('escalates to SIGKILL when the process ignores SIGTERM on timeout', async () => {
    const start = Date.now()
    const result = await runSubprocess({
      bin: '/bin/sh',
      // Busy-loop in the shell itself (no child holding the pipes): only
      // SIGKILL can end this.
      args: ['-c', 'trap "" TERM; while true; do :; done'],
      timeoutMs: 200,
      killGraceMs: 300
    })
    expect(result.timedOut).toBe(true)
    // SIGTERM at 200ms is ignored; SIGKILL at ~500ms must end it.
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('kills children in the process group so close is not held open by a grandchild', async () => {
    const start = Date.now()
    // sh spawns `sleep 30` which inherits the stderr pipe. Killing only sh
    // would leave sleep alive holding the pipe → 'close' after 30 s. The
    // group kill must take both down.
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'sleep 30'],
      timeoutMs: 200,
      killGraceMs: 300
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('resolves immediately with aborted=true when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    const result = await runSubprocess({
      bin: '/bin/sleep',
      args: ['30'],
      signal: controller.signal
    })
    expect(result.aborted).toBe(true)
    expect(result.code).toBeNull()
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('kills the process on mid-flight abort and resolves with aborted=true', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const start = Date.now()
    const result = await runSubprocess({
      bin: '/bin/sleep',
      args: ['30'],
      signal: controller.signal
    })
    expect(result.aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('escalates to SIGKILL when the process ignores SIGTERM on abort', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const start = Date.now()
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'trap "" TERM; while true; do :; done'],
      signal: controller.signal,
      killGraceMs: 300
    })
    expect(result.aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('caps stderr to maxStderrBytes keeping the tail', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      // 10000 bytes of 'a', then the marker at the very end
      args: ['-c', 'head -c 10000 /dev/zero | tr "\\0" a >&2; printf TAIL-MARKER >&2'],
      maxStderrBytes: 1_000
    })
    expect(result.stderr.length).toBeLessThanOrEqual(1_000)
    expect(result.stderr).toContain('TAIL-MARKER')
  })

  it('invokes onStderrLine for each complete stderr line', async () => {
    const lines: string[] = []
    await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'echo "line one" >&2; echo "line two" >&2'],
      onStderrLine: (line) => lines.push(line)
    })
    expect(lines).toEqual(['line one', 'line two'])
  })

  it('rejects when the binary does not exist', async () => {
    await expect(runSubprocess({ bin: '/nonexistent/binary-xyz', args: [] })).rejects.toThrow(
      /nonexistent/
    )
  })

  it('rejects when the binary does not exist even with nice wrapping', async () => {
    // `nice` itself exists, so without an explicit pre-check the spawn error
    // would be masked as a nice exit code instead of a crisp rejection.
    await expect(
      runSubprocess({ bin: '/nonexistent/binary-xyz', args: [], nice: 10 })
    ).rejects.toThrow(/nonexistent/)
  })

  it('runs the process through nice when nice is set', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf niced'],
      nice: 10
    })
    expect(result.stdout).toBe('niced')
    expect(result.code).toBe(0)
  })

  it('passes env overrides merged with the whitelist env', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf "$THERA_TEST_VAR-$HOME"'],
      env: { THERA_TEST_VAR: 'xyz' }
    })
    expect(result.stdout.startsWith('xyz-')).toBe(true)
    expect(result.stdout.length).toBeGreaterThan(4) // HOME steht auf der Whitelist
  })

  it('does NOT leak arbitrary process.env vars into the child', async () => {
    process.env.THERA_LEAK_TEST = 'leaked'
    try {
      const result = await runSubprocess({
        bin: '/bin/sh',
        args: ['-c', 'printf "[$THERA_LEAK_TEST]"']
      })
      expect(result.stdout).toBe('[]')
    } finally {
      delete process.env.THERA_LEAK_TEST
    }
  })

  it('pins PATH to the system default instead of inheriting the shell PATH', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf "$PATH"']
    })
    expect(result.stdout).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
  })

  describe('buildSubprocessEnv', () => {
    it('contains only whitelisted vars plus overrides', () => {
      process.env.THERA_LEAK_TEST = 'leaked'
      try {
        const env = buildSubprocessEnv({ OMP_NUM_THREADS: '4' })
        expect(env.THERA_LEAK_TEST).toBeUndefined()
        expect(env.OMP_NUM_THREADS).toBe('4')
        expect(env.HOME).toBe(process.env.HOME)
        expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')
      } finally {
        delete process.env.THERA_LEAK_TEST
      }
    })

    it('lets overrides win over whitelist values', () => {
      const env = buildSubprocessEnv({ PATH: '/custom/bin' })
      expect(env.PATH).toBe('/custom/bin')
    })
  })

  it('can ignore stdout for callers that read output from files', async () => {
    const result = await runSubprocess({
      bin: '/bin/sh',
      args: ['-c', 'printf ignored'],
      stdout: 'ignore'
    })
    expect(result.stdout).toBe('')
    expect(result.code).toBe(0)
  })
})
