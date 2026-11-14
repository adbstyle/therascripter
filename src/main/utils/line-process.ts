import { spawn, type ChildProcess } from 'child_process'
import { accessSync, constants } from 'fs'
import { StringDecoder } from 'string_decoder'
import { buildSubprocessEnv } from './subprocess'

/**
 * Langlebiger Kindprozess mit JSON-Lines auf stdin/stdout (Epic #192, Suchdienst).
 *
 * Der erste langlebige Kindprozess der App: alle anderen ML-Werkzeuge laufen
 * über `runSubprocess` (ein Aufruf, ein Prozess). Hier lebt der Prozess über
 * viele Anfragen hinweg; die Lebenszyklus-Regeln von `runSubprocess` gelten
 * trotzdem: Whitelist-Env (`buildSubprocessEnv`), eigene Prozessgruppe
 * (`detached`), Gruppen-SIGTERM → Frist → SIGKILL, stderr laufend geleert und
 * nur als Ringpuffer behalten.
 *
 * Protokoll (search_service.py):
 * - stdout trägt ausschliesslich Protokollzeilen. Die erste ist die Startzeile
 *   (`{"ready": true, …}`), danach je Anfrage genau eine Antwort mit ihrer `id`.
 * - Antworten mit `id: null` (`bad_json`, `too_large`: die Zeile war nicht
 *   lesbar) gehören zur ältesten offenen Anfrage — der Dienst beantwortet
 *   strikt in Reihenfolge.
 * - Fehler einer Anfrage: `{"id", "error": {"code", "message"}}` → Rejection
 *   mit `LineProcessRequestError`; der Prozess lebt weiter.
 * - Eine halbe letzte Zeile bei Prozessende wird verworfen.
 */

export interface LineProcessOptions {
  bin: string
  args: string[]
  /** Über die Whitelist-Env (buildSubprocessEnv) gelegt, NICHT über process.env. */
  env?: Record<string, string | undefined>
  /** Bis zur Startzeile; danach wird der Prozess beendet. Default 60 s. */
  startTimeoutMs?: number
  /** Ist diese stdout-Nachricht die Startzeile? Default: `ready === true`. */
  isReady?: (message: Record<string, unknown>) => boolean
  /** Frist zwischen stdin-EOF und SIGTERM beim Beenden. Default 2 s. */
  eofGraceMs?: number
  /** Frist zwischen SIGTERM und SIGKILL. Default 2 s. */
  killGraceMs?: number
  /** stderr-Ringpuffer in UTF-16-Einheiten. Default 64 Ki. */
  maxStderrChars?: number
  /** Jede vollständige stderr-Zeile. */
  onStderrLine?: (line: string) => void
}

export interface LineProcessExit {
  /** null, wenn der Prozess durch ein Signal endete. */
  code: number | null
  exitSignal: NodeJS.Signals | null
  /** true, wenn `stop()` das Ende verlangt hat (kein Absturz). */
  stopRequested: boolean
  /** true, wenn der Start-Timeout gegriffen hat. */
  startTimedOut: boolean
  /** Ende des stderr-Ringpuffers. */
  stderr: string
}

/** Fehlerantwort des Dienstes auf eine Anfrage. */
export class LineProcessRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LineProcessRequestError'
  }
}

/** Anfrage ohne Antwort in der Frist. Der Prozess läuft weiter — der Aufrufer entscheidet. */
export class LineProcessTimeoutError extends Error {
  constructor(
    readonly op: string,
    readonly timeoutMs: number
  ) {
    super(`Keine Antwort auf «${op}» innerhalb von ${timeoutMs} ms`)
    this.name = 'LineProcessTimeoutError'
  }
}

/** Der Prozess ist beendet (oder nie bereit geworden); offene Anfragen scheitern damit. */
export class LineProcessExitedError extends Error {
  constructor(
    readonly exit: LineProcessExit,
    message?: string
  ) {
    super(message ?? describeExit(exit))
    this.name = 'LineProcessExitedError'
  }
}

export function describeExit(exit: LineProcessExit): string {
  const how = exit.exitSignal ? `Signal ${exit.exitSignal}` : `Exit-Code ${exit.code}`
  const last = exit.stderr.trim().split('\n').pop() ?? ''
  return `Prozess beendet (${how})${last ? `: ${last}` : ''}`
}

interface PendingRequest {
  id: number
  op: string
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_START_TIMEOUT_MS = 60_000
const DEFAULT_EOF_GRACE_MS = 2_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_MAX_STDERR_CHARS = 64 * 1024
/** Vertragszeile des Suchdiensts nach dem Laden (Smoke-Check `search load`). */
const WEIGHTS_LINE = /^Gewichte: (.+)$/

export class LineProcess {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingRequest>()
  /** Reihenfolge der offenen Anfragen — für Antworten mit `id: null`. */
  private order: number[] = []
  private nextId = 1
  private stdoutDecoder = new StringDecoder('utf8')
  private stdoutBuffer = ''
  private stderrDecoder = new StringDecoder('utf8')
  private stderrLineBuffer = ''
  private stderrTail = ''
  private readyMessage: Record<string, unknown> | null = null
  private stopRequested = false
  private startTimedOut = false
  private exitInfo: LineProcessExit | null = null
  private exitWaiters: Array<(exit: LineProcessExit) => void> = []
  private readyWaiter: {
    resolve: (m: Record<string, unknown>) => void
    reject: (e: Error) => void
  } | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private termTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private terminating = false
  private weights: string | null = null

  constructor(private readonly opts: LineProcessOptions) {}

  /**
   * Startet den Prozess und wartet auf die Startzeile. Rejection mit
   * `LineProcessExitedError`, wenn er vorher endet oder der Start-Timeout
   * greift (dann wird er beendet). Nur einmal aufrufbar.
   */
  start(): Promise<Record<string, unknown>> {
    if (this.proc || this.exitInfo) return Promise.reject(new Error('LineProcess läuft schon'))
    // Klarer Fehler, statt eines undurchsichtigen spawn-Fehlers
    accessSync(this.opts.bin, constants.X_OK)
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.readyWaiter = { resolve, reject }
    })
    const proc = spawn(this.opts.bin, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSubprocessEnv(this.opts.env),
      // Eigene Prozessgruppe: Kill trifft auch Kinder (torch-Worker)
      detached: true
    })
    this.proc = proc

    proc.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk))
    proc.stderr!.on('data', (chunk: Buffer) => this.onStderr(chunk))
    // EPIPE beim Schreiben in einen sterbenden Prozess darf Node nicht kippen;
    // das Ende meldet 'close'.
    proc.stdin!.on('error', () => undefined)
    proc.on('error', (err) => {
      // spawn selbst gescheitert (sehr selten nach accessSync)
      this.finish(null, null, err.message)
    })
    proc.on('close', (code, signal) => this.finish(code, signal))

    const timeoutMs = this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.startTimer = setTimeout(() => {
      if (this.readyMessage) return
      this.startTimedOut = true
      this.terminate(0)
    }, timeoutMs)
    return ready
  }

  /** PID des Prozesses (Messungen, Tests). */
  get pid(): number | undefined {
    return this.proc?.pid
  }

  /** Startzeile, sobald bereit. */
  get ready(): Record<string, unknown> | null {
    return this.readyMessage
  }

  /** Inhalt der Vertragszeile «Gewichte: …» (z. B. «torch.bfloat16 auf mps»), sofern gesehen. */
  get weightsLine(): string | null {
    return this.weights
  }

  get stderr(): string {
    return this.stderrTail
  }

  get exited(): LineProcessExit | null {
    return this.exitInfo
  }

  /** Erfüllt sich mit dem Ende des Prozesses (auch wenn er schon beendet ist). */
  waitForExit(): Promise<LineProcessExit> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Schickt eine Anfrage (`op` plus Felder) und wartet auf die Antwort mit
   * derselben ID. Ohne Antwort in `timeoutMs` → `LineProcessTimeoutError`;
   * eine späte Antwort wird dann verworfen.
   */
  request(
    message: { op: string } & Record<string, unknown>,
    options: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>> {
    if (this.exitInfo) return Promise.reject(new LineProcessExitedError(this.exitInfo))
    if (!this.proc || !this.readyMessage) {
      return Promise.reject(new Error('Prozess ist nicht bereit'))
    }
    if (this.stopRequested) return Promise.reject(new Error('Prozess wird beendet'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { id, op: message.op, resolve, reject, timer: null }
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.dropPending(id)
          reject(new LineProcessTimeoutError(message.op, options.timeoutMs!))
        }, options.timeoutMs)
      }
      this.pending.set(id, entry)
      this.order.push(id)
      try {
        this.proc!.stdin!.write(`${JSON.stringify({ ...message, id })}\n`)
      } catch (err) {
        this.dropPending(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Beendet den Prozess: stdin schliessen (der Dienst endet bei EOF selbst),
   * nach `eofGraceMs` Gruppen-SIGTERM, nach `killGraceMs` SIGKILL. Idempotent;
   * erfüllt sich erst, wenn der Prozess nachweislich weg ist.
   */
  stop(): Promise<LineProcessExit> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    if (!this.proc) {
      // Nie gestartet
      this.stopRequested = true
      this.finish(null, null)
      return Promise.resolve(this.exitInfo!)
    }
    if (!this.stopRequested) {
      this.stopRequested = true
      try {
        this.proc.stdin!.end()
      } catch {
        // stdin schon zu
      }
      this.terminate(this.opts.eofGraceMs ?? DEFAULT_EOF_GRACE_MS)
    }
    return this.waitForExit()
  }

  /** Sofort SIGKILL an die Gruppe (Tests, Notfall). */
  kill(): void {
    this.stopRequested = true
    this.killGroup('SIGKILL')
  }

  /** SIGTERM an die Gruppe nach `afterMs`, SIGKILL nach der Frist. Idempotent. */
  private terminate(afterMs: number): void {
    if (this.terminating || this.exitInfo) return
    this.terminating = true
    const term = (): void => {
      this.termTimer = null
      this.killGroup('SIGTERM')
      this.killTimer = setTimeout(
        () => this.killGroup('SIGKILL'),
        this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
      )
    }
    if (afterMs <= 0) term()
    else this.termTimer = setTimeout(term, afterMs)
  }

  private killGroup(sig: NodeJS.Signals): void {
    const proc = this.proc
    if (!proc || this.exitInfo) return
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, sig)
      else proc.kill(sig)
    } catch {
      try {
        proc.kill(sig)
      } catch {
        // schon weg
      }
    }
  }

  private dropPending(id: number): void {
    const entry = this.pending.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    this.pending.delete(id)
    const at = this.order.indexOf(id)
    if (at >= 0) this.order.splice(at, 1)
  }

  private onStdout(chunk: Buffer): void {
    // StringDecoder: ein mehrbytiges Zeichen über eine Chunk-Grenze bleibt ganz
    this.stdoutBuffer += this.stdoutDecoder.write(chunk)
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      this.onLine(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      console.error(
        `[LineProcess] Unlesbare Zeile auf stdout verworfen (${trimmed.length} Zeichen)`
      )
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    const msg = message as Record<string, unknown>

    if (!this.readyMessage) {
      if ((this.opts.isReady ?? ((m) => m.ready === true))(msg)) {
        this.readyMessage = msg
        if (this.startTimer) clearTimeout(this.startTimer)
        this.startTimer = null
        this.readyWaiter?.resolve(msg)
        this.readyWaiter = null
      }
      return
    }

    let id: number | undefined
    if (typeof msg.id === 'number') id = msg.id
    else if (msg.id === null || msg.id === undefined) id = this.order[0]
    if (id === undefined) return
    const entry = this.pending.get(id)
    // Späte Antwort auf eine abgelaufene Anfrage
    if (!entry) return
    this.dropPending(id)
    const error = msg.error
    if (typeof error === 'object' && error !== null) {
      const e = error as Record<string, unknown>
      entry.reject(
        new LineProcessRequestError(
          typeof e.code === 'string' ? e.code : 'internal',
          typeof e.message === 'string' ? e.message : 'Fehler im Dienst'
        )
      )
      return
    }
    entry.resolve(msg)
  }

  private onStderr(chunk: Buffer): void {
    const text = this.stderrDecoder.write(chunk)
    this.stderrTail += text
    const max = this.opts.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS
    if (this.stderrTail.length > max) this.stderrTail = this.stderrTail.slice(-max)
    this.stderrLineBuffer += text
    const lines = this.stderrLineBuffer.split('\n')
    this.stderrLineBuffer = lines.pop() ?? ''
    // Eine Zeile ohne Ende darf den Puffer nicht unbegrenzt wachsen lassen
    if (this.stderrLineBuffer.length > max)
      this.stderrLineBuffer = this.stderrLineBuffer.slice(-max)
    for (const line of lines) this.onStderrLine(line)
  }

  private onStderrLine(line: string): void {
    const weights = WEIGHTS_LINE.exec(line.trim())
    if (weights) this.weights = weights[1]
    try {
      this.opts.onStderrLine?.(line)
    } catch {
      // Ein Beobachter darf den Prozess nicht stören
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exitInfo) return
    if (this.stderrLineBuffer.length > 0) {
      this.onStderrLine(this.stderrLineBuffer)
      this.stderrLineBuffer = ''
    }
    if (spawnError) this.stderrTail += `${spawnError}\n`
    // Halbe letzte Zeile ohne Zeilenende: verwerfen
    this.stdoutBuffer = ''
    for (const timer of [this.startTimer, this.termTimer, this.killTimer]) {
      if (timer) clearTimeout(timer)
    }
    this.exitInfo = {
      code,
      exitSignal: signal,
      stopRequested: this.stopRequested,
      startTimedOut: this.startTimedOut,
      stderr: this.stderrTail
    }
    const exit = this.exitInfo
    const error = new LineProcessExitedError(
      exit,
      this.startTimedOut
        ? `Keine Startzeile innerhalb der Frist — ${describeExit(exit)}`
        : undefined
    )
    this.readyWaiter?.reject(error)
    this.readyWaiter = null
    const open = [...this.pending.values()]
    this.pending.clear()
    this.order = []
    for (const entry of open) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
    }
    for (const waiter of this.exitWaiters.splice(0)) waiter(exit)
  }
}
