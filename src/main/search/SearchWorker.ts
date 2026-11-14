import {
  LineProcess,
  LineProcessExitedError,
  LineProcessRequestError,
  LineProcessTimeoutError,
  describeExit,
  type LineProcessExit,
  type LineProcessOptions
} from '../utils/line-process'
import type { SearchModelInfo } from './searchModel'
import {
  SEARCH_WORKER_BATCH_TIMEOUT_MS,
  SEARCH_WORKER_FAILURE_COOLDOWN_MS,
  SEARCH_WORKER_IDLE_MS,
  SEARCH_WORKER_MAX_START_FAILURES,
  SEARCH_WORKER_QUERY_TIMEOUT_MS,
  SEARCH_WORKER_RESTART_FOOTPRINT_BYTES,
  SEARCH_WORKER_START_TIMEOUT_MS
} from '../../shared/search-config'
import type {
  SearchProcessPhase,
  SearchProcessState,
  SearchUnavailableReason
} from '../../shared/types/Search'

/**
 * Langlebiger Suchprozess (Epic #192 — #209; Bauplan Abschnitt 5b).
 *
 * EIN Python-Prozess (`search_service.py serve`) für Anfragen UND
 * Aufbereitung — zwei Modellkopien wären über 3 GiB. Der Prozess ist
 * zustandslos: er übersetzt Text in Vektoren, Node hält und vergleicht sie.
 *
 * Regeln:
 * - Nie gleichzeitig mit NER, whisper oder llama (8-GB-Budget): `ensureStarted`
 *   wird abgelehnt, solange eine Verarbeitung läuft oder ansteht
 *   (`isProcessingActive`), und der Hook vor jedem Task der Warteschlange
 *   beendet den Prozess (`stop('processing')`), bevor der Task beginnt.
 *   Während einer Aufnahme sind Anfragen erlaubt (Entscheid des Orchestrators);
 *   die Aufbereitung prüft die Aufnahme selbst.
 * - Arbeitsspeicher frei (#209 AK 17): gezählt wird nur die letzte
 *   USER-Interaktion (Öffnen der Suche, Anfrage), nicht die Aufbereitung.
 *   SEARCH_WORKER_IDLE_MS danach endet der Prozess — ausser die Aufbereitung
 *   läuft gerade; endet sie (fertig, pausiert, abgebrochen) und liegt die
 *   letzte USER-Interaktion länger zurück, endet er sofort.
 * - Jede Antwort trägt `phys_footprint_bytes`; ab
 *   SEARCH_WORKER_RESTART_FOOTPRINT_BYTES startet der Prozess neu, sobald
 *   keine Anfrage mehr offen ist (zwischen zwei Batches) — gleich danach,
 *   wenn er gebraucht wird, nicht erst bei der nächsten Anfrage.
 * - Ein unerwartetes Ende (Absturz, SIGKILL, Timeout) meldet 'error' bzw.
 *   nach der Nachprüfung 'tool-blocked' — nur während der Pause
 *   SEARCH_WORKER_FAILURE_COOLDOWN_MS; danach versucht die nächste Anfrage
 *   einen Neustart. Eine Blockade, die Therascript selbst behoben hat, gibt
 *   sofort den Neuversuch frei.
 * - Nach SEARCH_WORKER_MAX_START_FAILURES gescheiterten Starts in Folge
 *   startet die Aufbereitung den Prozess nicht mehr (keine Startschleife mit
 *   Speicherspitze), bis sich etwas ändert: Modell neu bereitgestellt
 *   (`resetStartFailures`), erfolgreicher Start durch eine USER-Suche oder
 *   App-Neustart. Bis dahin meldet `getState` 'error' mit Begründung.
 */

/** Warum ein Aufruf nicht bedient wurde; 'stopped': der Prozess wurde gerade beendet. */
export type SearchWorkerFailure = SearchUnavailableReason | 'stopped'

/**
 * Woher der Fehler kommt — die Vektorphase rechnet nur 'request' (der Batch
 * dieser Sitzung liess den Prozess abstürzen bzw. hängen) der Sitzung an.
 * - request: Absturz/Timeout während dieses Aufrufs
 * - start: der Prozess liess sich nicht starten
 * - cooldown: Pause nach einem Fehler, nichts versucht
 * - blocked: Starts für die Aufbereitung nach wiederholtem Scheitern angehalten
 * - stopping: der Prozess wurde gerade (absichtlich) beendet
 * - state: Verarbeitung läuft, Modell fehlt, App wird beendet
 */
export type SearchWorkerFailureKind =
  | 'request'
  | 'start'
  | 'cooldown'
  | 'blocked'
  | 'stopping'
  | 'state'

export class SearchWorkerUnavailableError extends Error {
  constructor(
    readonly reason: SearchWorkerFailure,
    message?: string,
    readonly kind: SearchWorkerFailureKind = 'state'
  ) {
    super(message ?? `Suche nach Bedeutung nicht verfügbar (${reason})`)
    this.name = 'SearchWorkerUnavailableError'
  }
}

export type SearchWorkerStopReason =
  | 'idle'
  | 'processing'
  | 'memory'
  | 'timeout'
  | 'quit'
  | 'update'
  | 'test'

/** warmup/query = USER-Interaktion; index = Aufbereitung; restart = nach Speicher-Neustart. */
export type SearchWorkerStartPurpose = 'warmup' | 'query' | 'index' | 'restart'

export type ToolCheckOutcome = 'blocked' | 'repaired' | 'none'

export interface SearchWorkerDeps {
  resolveModel: () => SearchModelInfo | null
  /** Python-Interpreter und Skript (resolvePythonSidecar). Wirft, wenn keins da ist. */
  resolveCommand: () => { bin: string; args: string[] }
  /** Läuft eine Verarbeitung oder steht eine an? (TaskQueueService.hasActiveWork) */
  isProcessingActive: () => boolean
  /** Nach einem SIGKILL von aussen: blockiert macOS das Werkzeug? (ToolHealthService.recheck) */
  checkToolBlocked?: (exit: LineProcessExit) => Promise<ToolCheckOutcome>
  /** Erst danach wird gestartet — dieselbe Werkzeug-Prüfung, auf die die Queue wartet. */
  startGate?: () => Promise<unknown>
  createProcess?: (opts: LineProcessOptions) => LineProcess
  now?: () => number
  idleMs?: number
  startTimeoutMs?: number
  queryTimeoutMs?: number
  batchTimeoutMs?: number
  restartFootprintBytes?: number
  failureCooldownMs?: number
  maxStartFailures?: number
  eofGraceMs?: number
  killGraceMs?: number
  /** Zusätzliche Variablen für den Prozess (Tests, Messungen). */
  extraEnv?: Record<string, string>
}

/** base64 float32 LE → Float32Array der erwarteten Länge. */
export function decodeVector(base64: unknown, dim: number): Float32Array {
  if (typeof base64 !== 'string') throw new Error('Antwort ohne Vektor')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length !== dim * 4) {
    throw new Error(`Vektor mit ${bytes.length / 4} statt ${dim} Dimensionen`)
  }
  // Kopie: der Buffer kann ein geteilter Pool-Ausschnitt mit Versatz sein
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = bytes.readFloatLE(i * 4)
  return out
}

/** Meldung, wenn die Starts angehalten sind (SearchAvailability.semanticMessage). */
export const START_BLOCKED_MESSAGE =
  'Das Suchmodell liess sich mehrmals nicht starten. Die Suche nach Bedeutung versucht es bei Ihrer nächsten Suche erneut; genaue Begriffe finden Sie weiterhin.'
const CRASH_MESSAGE =
  'Die Suche nach Bedeutung ist kurz ausgefallen und startet gleich von selbst neu.'
const BLOCKED_MESSAGE =
  'macOS hat ein Werkzeug von Therascript blockiert; die Suche nach Bedeutung ist bis zur Freigabe nicht verfügbar.'

/** Bei quit/update schnell eskalieren: SIGKILL nach 0.5 + 1 s, spätestens fertig nach 2.5 s. */
const FAST_STOP = { eofGraceMs: 500, killGraceMs: 1_000 }

export class SearchWorker {
  private proc: LineProcess | null = null
  private phase: SearchProcessPhase = 'stopped'
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private exitHandling: Promise<void> = Promise.resolve()
  private inflight = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private restartPending = false
  private stopReason: SearchWorkerStopReason | null = null
  private failure: {
    reason: 'tool-blocked' | 'error'
    at: number
    cooldownMs: number
    message: string
  } | null = null
  private startFailures = 0
  private closed = false
  private indexing = false
  private lastUserActivity: number | null = null
  private model: SearchModelInfo | null = null
  private lastFootprint: number | null = null
  private peakFootprint = 0
  private stateListeners = new Set<(state: SearchProcessState) => void>()
  private stopListeners = new Set<(reason: SearchWorkerStopReason | 'crash') => void>()
  private lastEmitted = ''
  private readonly now: () => number

  constructor(private readonly deps: SearchWorkerDeps) {
    this.now = deps.now ?? Date.now
  }

  private get idleMs(): number {
    return this.deps.idleMs ?? SEARCH_WORKER_IDLE_MS
  }

  private get startsBlocked(): boolean {
    return this.startFailures >= (this.deps.maxStartFailures ?? SEARCH_WORKER_MAX_START_FAILURES)
  }

  private failureActive(): boolean {
    return this.failure !== null && this.now() - this.failure.at < this.failure.cooldownMs
  }

  /** Prozesszustand plus Grund, warum die Suche nach Bedeutung gerade nicht geht. */
  getState(): SearchProcessState {
    return { phase: this.phase, reason: this.unavailableReason() }
  }

  /** Verständlicher Grund zu 'error'/'tool-blocked' (für SearchAvailability), sonst null. */
  getMessage(): string | null {
    const reason = this.unavailableReason()
    if (reason === 'error') return this.startsBlocked ? START_BLOCKED_MESSAGE : CRASH_MESSAGE
    if (reason === 'tool-blocked') return BLOCKED_MESSAGE
    return null
  }

  /**
   * Grund aus Sicht einer USER-Suche: wie getState().reason, aber angehaltene
   * Starts zählen nicht — eine USER-Suche darf es nach der Pause erneut
   * versuchen (und hebt die Sperre bei Erfolg auf).
   */
  getUserReason(): SearchUnavailableReason | null {
    if (this.deps.isProcessingActive()) return 'processing'
    if (!this.deps.resolveModel()) return 'model-missing'
    if (this.failureActive()) return this.failure!.reason
    return null
  }

  private unavailableReason(): SearchUnavailableReason | null {
    if (this.deps.isProcessingActive()) return 'processing'
    if (!this.deps.resolveModel()) return 'model-missing'
    if (this.failureActive()) return this.failure!.reason
    if (this.startsBlocked) return 'error'
    return null
  }

  /** Letzter gemeldeter phys_footprint des Prozesses (Messungen). */
  get footprint(): { last: number | null; peak: number } {
    return { last: this.lastFootprint, peak: this.peakFootprint }
  }

  get pid(): number | undefined {
    return this.proc?.pid
  }

  /** Informiert bei jeder Änderung von Phase oder Grund. */
  onStateChange(listener: (state: SearchProcessState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  /** Nach jedem Ende des Prozesses ('crash' = unerwartet). */
  onStopped(listener: (reason: SearchWorkerStopReason | 'crash') => void): () => void {
    this.stopListeners.add(listener)
    return () => this.stopListeners.delete(listener)
  }

  /**
   * Meldet den Zustand neu, falls sich der Grund ohne eigenes Zutun geändert
   * hat (Warteschlange, Modell installiert, Ende einer Pause).
   */
  refreshState(): void {
    this.emit()
  }

  /** Modell neu bereitgestellt: angehaltene Starts wieder zulassen. */
  resetStartFailures(): void {
    this.startFailures = 0
    this.failure = null
    this.emit()
  }

  private emit(): void {
    const state = this.getState()
    const key = `${state.phase}:${state.reason}`
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    for (const listener of this.stateListeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('[SearchWorker] Zustands-Beobachter fehlgeschlagen:', error)
      }
    }
  }

  private setPhase(phase: SearchProcessPhase): void {
    this.phase = phase
    this.emit()
  }

  // ── Leerlauf (#209 AK 17) ─────────────────────────────────────────────

  private userIdle(): boolean {
    return this.lastUserActivity === null || this.now() - this.lastUserActivity >= this.idleMs
  }

  private touchUser(): void {
    this.lastUserActivity = this.now()
    this.scheduleIdle()
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (this.lastUserActivity === null) return
    const due = Math.max(0, this.lastUserActivity + this.idleMs - this.now())
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.maybeStopIdle()
    }, due)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** Beenden, wenn niemand den Prozess braucht: keine offene Anfrage, keine Aufbereitung, USER untätig. */
  private maybeStopIdle(): void {
    if (!this.proc || this.phase === 'stopping' || this.startPromise) return
    if (this.inflight > 0 || this.indexing) return
    if (!this.userIdle()) {
      this.scheduleIdle()
      return
    }
    console.log('[SearchWorker] keine Suche in den letzten 5 Minuten — Suchprozess wird beendet')
    void this.stop('idle')
  }

  /**
   * Die Vektorphase meldet Beginn und Ende. Endet sie (fertig, pausiert,
   * abgebrochen — auch beim Beginn einer Aufnahme) und hat der USER länger
   * nicht gesucht, endet der Prozess sofort.
   */
  setIndexing(active: boolean): void {
    this.indexing = active
    if (!active) this.maybeStopIdle()
  }

  // ── Start und Stopp ───────────────────────────────────────────────────

  /**
   * Startet den Prozess, falls nötig (Single-Flight: parallele Aufrufe teilen
   * einen Start). Abgelehnt mit SearchWorkerUnavailableError, solange eine
   * Verarbeitung läuft oder ansteht, das Modell fehlt, nach einem Fehler die
   * Pause läuft oder (nur Aufbereitung) die Starts angehalten sind.
   */
  async ensureStarted(purpose: SearchWorkerStartPurpose): Promise<void> {
    if (purpose === 'warmup' || purpose === 'query') this.touchUser()
    if (this.deps.startGate) await this.deps.startGate()
    for (;;) {
      if (this.closed) throw new SearchWorkerUnavailableError('stopped', 'App wird beendet')
      if (this.deps.isProcessingActive()) throw new SearchWorkerUnavailableError('processing')
      if (!this.deps.resolveModel()) throw new SearchWorkerUnavailableError('model-missing')
      if (this.failureActive()) {
        throw new SearchWorkerUnavailableError(
          this.failure!.reason,
          this.failure!.message,
          'cooldown'
        )
      }
      if (this.stopPromise) {
        await this.stopPromise
        continue
      }
      if (this.startPromise) {
        await this.startPromise
        return
      }
      if (this.proc && (this.phase === 'ready' || this.phase === 'busy')) return
      if ((purpose === 'index' || purpose === 'restart') && this.startsBlocked) {
        throw new SearchWorkerUnavailableError('error', START_BLOCKED_MESSAGE, 'blocked')
      }
      this.startPromise = this.spawn().finally(() => {
        this.startPromise = null
      })
      await this.startPromise
      return
    }
  }

  private async spawn(): Promise<void> {
    const model = this.deps.resolveModel()
    if (!model) throw new SearchWorkerUnavailableError('model-missing')
    let command: { bin: string; args: string[] }
    try {
      command = this.deps.resolveCommand()
    } catch (error) {
      this.recordStartFailure(error instanceof Error ? error.message : String(error))
      throw new SearchWorkerUnavailableError('error', this.failure?.message, 'start')
    }
    this.model = model
    this.stopReason = null
    this.restartPending = false
    const opts: LineProcessOptions = {
      bin: command.bin,
      args: [
        ...command.args,
        'serve',
        '--model-dir',
        model.dir,
        '--query-prompt',
        model.queryPrompt,
        '--document-prompt',
        model.documentPrompt,
        '--max-tokens',
        String(model.maxTokens),
        '--pad-multiple',
        String(model.padMultiple)
      ],
      env: {
        // Nichts verlässt den Mac (#209 AK 20): kein Hub-Zugriff
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        // Kein pyc-Nachschreiben ins signierte Bundle (wie die anderen Sidecars)
        PYTHONDONTWRITEBYTECODE: '1',
        OMP_NUM_THREADS: '4',
        MKL_NUM_THREADS: '4',
        TOKENIZERS_PARALLELISM: 'false',
        ...this.deps.extraEnv
      },
      startTimeoutMs: this.deps.startTimeoutMs ?? SEARCH_WORKER_START_TIMEOUT_MS,
      eofGraceMs: this.deps.eofGraceMs,
      killGraceMs: this.deps.killGraceMs,
      onStderrLine: (line) => {
        if (line.startsWith('Fehler') || line.includes('Traceback')) {
          console.error(`[SearchWorker] ${line}`)
        }
      }
    }
    const proc = (this.deps.createProcess ?? ((o) => new LineProcess(o)))(opts)
    this.proc = proc
    this.setPhase('starting')
    proc.waitForExit().then((exit) => {
      this.exitHandling = this.onExit(proc, exit)
    })
    let ready: Record<string, unknown>
    try {
      ready = await proc.start()
    } catch (error) {
      await proc.waitForExit()
      await this.exitHandling
      if (this.stopReason !== null) {
        throw new SearchWorkerUnavailableError(
          this.stopReason === 'processing' ? 'processing' : 'stopped',
          undefined,
          'stopping'
        )
      }
      // Ein blockiertes Werkzeug hat onExit schon als solches vermerkt
      if (this.failure?.reason !== 'tool-blocked') {
        this.recordStartFailure(error instanceof Error ? error.message : String(error))
      } else {
        this.startFailures++
      }
      throw new SearchWorkerUnavailableError(
        this.failure?.reason ?? 'error',
        this.failure?.message,
        'start'
      )
    }
    if (typeof ready.dim === 'number' && ready.dim !== model.dim) {
      this.recordStartFailure(`Suchmodell liefert ${ready.dim} statt ${model.dim} Dimensionen`)
      await this.stop('test')
      throw new SearchWorkerUnavailableError('error', this.failure?.message, 'start')
    }
    this.trackFootprint(ready)
    this.failure = null
    this.startFailures = 0
    console.log(
      `[SearchWorker] bereit (${String(ready.device)}, ${String(ready.dtype)}, ${String(ready.load_ms)} ms, ${proc.weightsLine ?? '—'})`
    )
    this.setPhase('ready')
    this.scheduleIdle()
    // Gestartet, aber von niemandem gebraucht (Aufbereitung inzwischen vorbei)?
    if (!this.indexing && this.inflight === 0 && this.userIdle()) {
      setImmediate(() => this.maybeStopIdle())
    }
  }

  private recordFailure(
    reason: 'tool-blocked' | 'error',
    message: string,
    cooldownMs?: number
  ): void {
    this.failure = {
      reason,
      at: this.now(),
      cooldownMs: cooldownMs ?? this.deps.failureCooldownMs ?? SEARCH_WORKER_FAILURE_COOLDOWN_MS,
      message
    }
  }

  private recordStartFailure(message: string): void {
    this.startFailures++
    this.recordFailure('error', message)
    if (this.startsBlocked) {
      console.error(
        `[SearchWorker] ${this.startFailures} gescheiterte Starts in Folge — Aufbereitung startet den Suchprozess nicht mehr, bis sich etwas ändert`
      )
    }
    this.emit()
  }

  private async onExit(proc: LineProcess, exit: LineProcessExit): Promise<void> {
    if (proc !== this.proc) return
    const expected = exit.stopRequested && !exit.startTimedOut
    if (!expected) {
      let outcome: ToolCheckOutcome = 'none'
      if (exit.exitSignal === 'SIGKILL') {
        try {
          outcome = (await this.deps.checkToolBlocked?.(exit)) ?? 'none'
        } catch {
          // Nachprüfung gescheitert — bleibt ein gewöhnlicher Fehler
        }
      }
      if (outcome === 'blocked') this.recordFailure('tool-blocked', describeExit(exit))
      // Von Therascript behoben: sofortiger Neuversuch erlaubt
      else if (outcome === 'repaired') this.failure = null
      else this.recordFailure('error', describeExit(exit))
      console.error(`[SearchWorker] Suchprozess unerwartet beendet: ${describeExit(exit)}`)
    }
    this.proc = null
    this.inflight = 0
    this.clearIdle()
    this.setPhase('stopped')
    const reason = expected ? (this.stopReason ?? 'test') : 'crash'
    for (const listener of this.stopListeners) {
      try {
        listener(reason)
      } catch (error) {
        console.error('[SearchWorker] Stopp-Beobachter fehlgeschlagen:', error)
      }
    }
  }

  /**
   * Beendet den Prozess (stdin-EOF → SIGTERM → SIGKILL). Idempotent, wirkt
   * auch während des Startens; erfüllt sich erst, wenn der Prozess weg ist
   * (LineProcess garantiert eine Obergrenze nach dem SIGKILL).
   */
  stop(reason: SearchWorkerStopReason): Promise<void> {
    if (reason === 'quit' || reason === 'update') this.closed = true
    this.clearIdle()
    const proc = this.proc
    if (!proc) return this.stopPromise ?? Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.stopReason = reason
    this.setPhase('stopping')
    const fast = reason === 'quit' || reason === 'update'
    this.stopPromise = proc
      .stop(fast ? FAST_STOP : {})
      .then(async () => {
        // onExit läuft über waitForExit — erst danach ist der Zustand gesetzt
        await new Promise((r) => setImmediate(r))
        await this.exitHandling
      })
      .finally(() => {
        this.stopPromise = null
      })
    return this.stopPromise
  }

  /**
   * Beim Beenden der App: SIGKILL nach spätestens 1.5 s, beendet nach
   * spätestens 2.5 s (LineProcess); `timeoutMs` ist nur die äussere Sicherung.
   */
  async shutdown(timeoutMs = 3_000): Promise<void> {
    await Promise.race([
      this.stop('quit'),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())
    ])
  }

  private trackFootprint(message: Record<string, unknown>): void {
    const value = message.phys_footprint_bytes
    if (typeof value !== 'number') return
    this.lastFootprint = value
    this.peakFootprint = Math.max(this.peakFootprint, value)
    const limit = this.deps.restartFootprintBytes ?? SEARCH_WORKER_RESTART_FOOTPRINT_BYTES
    if (value > limit) this.restartPending = true
  }

  /** Neustart wegen Speicherwachstum — gleich wieder starten, wenn der Prozess gebraucht wird. */
  private restartForMemory(): void {
    console.log(
      `[SearchWorker] phys_footprint ${this.lastFootprint} Bytes über der Grenze — Neustart`
    )
    this.restartPending = false
    void this.stop('memory').then(() => {
      if (this.indexing || !this.userIdle()) {
        this.ensureStarted('restart').catch(() => undefined)
      }
    })
  }

  private async call(
    message: { op: string } & Record<string, unknown>,
    timeoutMs: number,
    user: boolean
  ): Promise<Record<string, unknown>> {
    const proc = this.proc
    if (!proc || this.phase === 'stopping' || this.phase === 'stopped') {
      throw new SearchWorkerUnavailableError('stopped', undefined, 'stopping')
    }
    this.inflight++
    if (this.phase === 'ready') this.setPhase('busy')
    try {
      const response = await proc.request(message, { timeoutMs })
      this.trackFootprint(response)
      return response
    } catch (error) {
      if (error instanceof LineProcessTimeoutError) {
        // Ein Dienst ohne Antwort ist festgefahren: beenden, kurze Pause
        this.recordFailure('error', error.message)
        void this.stop('timeout')
        throw new SearchWorkerUnavailableError('error', error.message, 'request')
      }
      if (error instanceof LineProcessExitedError) {
        await this.exitHandling
        const stop = this.stopReason
        if (stop === 'processing') {
          throw new SearchWorkerUnavailableError('processing', error.message, 'stopping')
        }
        if (stop !== null)
          throw new SearchWorkerUnavailableError('stopped', error.message, 'stopping')
        throw new SearchWorkerUnavailableError(
          this.failure?.reason ?? 'error',
          error.message,
          'request'
        )
      }
      if (error instanceof LineProcessRequestError) {
        throw new Error(`Suchdienst: ${error.code}: ${error.message}`)
      }
      throw error
    } finally {
      this.inflight = Math.max(0, this.inflight - 1)
      if (user) this.touchUser()
      if (this.inflight === 0 && this.proc === proc && this.phase === 'busy') {
        this.setPhase('ready')
        if (this.restartPending) this.restartForMemory()
        else this.maybeStopIdle()
      }
    }
  }

  /**
   * Ein Aufruf mit einem zweiten Versuch, wenn er genau in ein absichtliches
   * Stoppfenster fiel (Leerlauf, Speicher-Neustart): dann neu starten statt
   * 'error' zu melden.
   */
  private async withRestart<T>(
    purpose: SearchWorkerStartPurpose,
    run: (model: SearchModelInfo) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureStarted(purpose)
      try {
        return await run(this.model!)
      } catch (error) {
        const retry =
          attempt === 0 &&
          error instanceof SearchWorkerUnavailableError &&
          error.reason === 'stopped' &&
          error.kind === 'stopping' &&
          !this.closed &&
          (this.stopReason === 'idle' || this.stopReason === 'memory' || this.stopReason === null)
        if (!retry) throw error
      }
    }
  }

  /** Vektor einer Suchanfrage (normalisiert). Startet den Prozess bei Bedarf. */
  embedQuery(text: string): Promise<Float32Array> {
    return this.withRestart('query', async (model) => {
      const response = await this.call(
        { op: 'embed_query', text },
        this.deps.queryTimeoutMs ?? SEARCH_WORKER_QUERY_TIMEOUT_MS,
        true
      )
      return decodeVector(response.vector, model.dim)
    })
  }

  /** Vektoren von Abschnitten (normalisiert), in der Reihenfolge der Texte. */
  embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return this.withRestart('index', async (model) => {
      if (texts.length === 0) return []
      const response = await this.call(
        { op: 'embed_documents', texts },
        this.deps.batchTimeoutMs ?? SEARCH_WORKER_BATCH_TIMEOUT_MS,
        false
      )
      const vectors = response.vectors
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error('Suchdienst: Antwort mit falscher Anzahl Vektoren')
      }
      return vectors.map((v) => decodeVector(v, model.dim))
    })
  }

  /** Modell des laufenden bzw. zuletzt gestarteten Prozesses. */
  get currentModel(): SearchModelInfo | null {
    return this.model
  }
}
