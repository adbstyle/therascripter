import { spawn } from 'child_process'
import { accessSync, constants } from 'fs'

// Shared subprocess runner for all ML tool invocations (whisper-cli, python
// sidecar, llama-cli, vision-ocr, ffmpeg). Centralizes the lifecycle handling
// that was previously duplicated — subtly differently — across six wrappers:
//
// - Pre-aborted-signal guard (addEventListener('abort') does NOT fire for an
//   already-aborted signal; without the guard the process would run
//   unsupervised — live-verified leak, PR #79 Bug #2).
// - SIGTERM → killGraceMs → SIGKILL escalation on BOTH timeout and abort.
//   The old wrappers escalated only on abort; their timeout path sent a lone
//   SIGTERM and removed the abort listener, leaving a zombie if the process
//   ignored SIGTERM (torch inside a native call does).
// - Resolution only after 'close' — the process is provably gone, no early
//   reject while the child still runs.
// - stderr tail ring-buffer so a chatty process cannot balloon memory.
//
// Policy stays with the callers: runSubprocess RESOLVES on any exit (including
// non-zero codes, timeout and abort — see SubprocessResult flags) and rejects
// only when the process could not be started at all. Error mapping to German
// user-facing messages lives in the services.

export interface SubprocessOptions {
  bin: string
  args: string[]
  /** No timeout when omitted. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Wrap in `nice -n <n>` (NFR-23 QoS). */
  nice?: number
  /** Merged over process.env. */
  env?: Record<string, string | undefined>
  /** 'ignore' for callers that read output from files (whisper -ojf). */
  stdout?: 'capture' | 'ignore'
  /** Called once per complete stderr line (progress parsing). */
  onStderrLine?: (line: string) => void
  /** Grace period between SIGTERM and SIGKILL. Default 5000 ms. */
  killGraceMs?: number
  /** stderr tail cap. Default 64 KiB. */
  maxStderrBytes?: number
}

export interface SubprocessResult {
  stdout: string
  /** Tail-capped at maxStderrBytes. */
  stderr: string
  /** null when the process was killed by a signal. */
  code: number | null
  timedOut: boolean
  aborted: boolean
}

const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024

// async, damit der synchrone accessSync-Throw als Rejection ankommt statt
// als Sync-Exception am Call-Site.
export async function runSubprocess(opts: SubprocessOptions): Promise<SubprocessResult> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  const captureStdout = opts.stdout !== 'ignore'

  // Crisp start failure even under nice-wrapping: with `nice` as argv[0] the
  // 'error' event only fires if nice itself is missing — a missing target
  // binary would surface as an opaque exit code instead.
  accessSync(opts.bin, constants.X_OK)

  // Pre-aborted guard: 'abort' listeners never fire for an already-aborted
  // signal, so spawning would leak an unsupervised process.
  if (opts.signal?.aborted) {
    return { stdout: '', stderr: '', code: null, timedOut: false, aborted: true }
  }

  return new Promise((resolve, reject) => {
    const argv0 = opts.nice !== undefined ? 'nice' : opts.bin
    const argv =
      opts.nice !== undefined ? ['-n', String(opts.nice), opts.bin, ...opts.args] : opts.args

    const proc = spawn(argv0, argv, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
      env: { ...process.env, ...opts.env },
      // Eigene Process-Group: Kill-Eskalation trifft die GANZE Gruppe. Ohne
      // das hält ein Kind des Targets (z. B. torch-Worker, sh-Subprozess) die
      // stderr-Pipe offen — 'close' feuert dann erst, wenn das Enkelkind von
      // selbst stirbt, und der "gekillte" Task lebt unsichtbar weiter.
      detached: true
    })

    let stdout = ''
    let stderr = ''
    let stderrLineBuffer = ''
    let timedOut = false
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    // Signal an die ganze Process-Group (negative PID); Fallback auf den
    // direkten Kill, falls die Gruppe schon weg ist.
    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, sig)
        } else {
          proc.kill(sig)
        }
      } catch {
        try {
          proc.kill(sig)
        } catch {
          // process already gone
        }
      }
    }

    // SIGTERM now, SIGKILL after the grace period. Idempotent — the first
    // caller (timeout or abort) wins; a second invocation is a no-op because
    // the flags are already set and kill() on a dead process is harmless.
    const terminate = (): void => {
      killGroup('SIGTERM')
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          killGroup('SIGKILL')
        }, killGraceMs)
      }
    }

    const onAbort = (): void => {
      aborted = true
      terminate()
    }
    opts.signal?.addEventListener('abort', onAbort)

    if (opts.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, opts.timeoutMs)
    }

    const cleanup = (): void => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
    }

    if (captureStdout) {
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
    }

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > maxStderrBytes) {
        stderr = stderr.slice(stderr.length - maxStderrBytes)
      }
      if (opts.onStderrLine) {
        stderrLineBuffer += text
        const lines = stderrLineBuffer.split('\n')
        stderrLineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          opts.onStderrLine(line)
        }
      }
    })

    proc.on('error', (err) => {
      cleanup()
      reject(err)
    })

    proc.on('close', (code) => {
      cleanup()
      if (opts.onStderrLine && stderrLineBuffer.length > 0) {
        opts.onStderrLine(stderrLineBuffer)
      }
      resolve({ stdout, stderr, code, timedOut, aborted })
    })
  })
}
