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
 * - Arbeitsspeicher frei nach SEARCH_WORKER_IDLE_MS ohne Anfrage bzw. Batch
 *   (#209 AK 17).
 * - Jede Antwort trägt `phys_footprint_bytes`; auf MPS wächst der Prozess pro
 *   Forward-Pass ausserhalb des torch-Allokators. Ab
 *   SEARCH_WORKER_RESTART_FOOTPRINT_BYTES wird er neu gestartet — erst, wenn
 *   keine Anfrage mehr offen ist, also zwischen zwei Batches.
 * - Ein unerwartetes Ende (Absturz, SIGKILL) setzt den Grund 'error' bzw.
 *   nach der Nachprüfung 'tool-blocked'; ein neuer Start folgt frühestens
 *   nach SEARCH_WORKER_FAILURE_COOLDOWN_MS (keine Startschleife bei jedem
 *   Tastendruck).
 */

/** Warum ein Aufruf nicht bedient wurde; 'stopped': der Prozess wurde gerade beendet. */
export type SearchWorkerFailure = SearchUnavailableReason | 'stopped'

export class SearchWorkerUnavailableError extends Error {
  constructor(
    readonly reason: SearchWorkerFailure,
    message?: string
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

export type SearchWorkerStartPurpose = 'warmup' | 'query' | 'index'

export interface SearchWorkerDeps {
  resolveModel: () => SearchModelInfo | null
  /** Python-Interpreter und Skript (resolvePythonSidecar). Wirft, wenn keins da ist. */
  resolveCommand: () => { bin: string; args: string[] }
  /** Läuft eine Verarbeitung oder steht eine an? (TaskQueueService.hasActiveWork) */
  isProcessingActive: () => boolean
  /** Nach einem SIGKILL von aussen: ist das Werkzeug blockiert? (throwIfToolBlocked) */
  isToolBlocked?: (exit: LineProcessExit) => Promise<boolean>
  createProcess?: (opts: LineProcessOptions) => LineProcess
  now?: () => number
  idleMs?: number
  startTimeoutMs?: number
  queryTimeoutMs?: number
  batchTimeoutMs?: number
  restartFootprintBytes?: number
  failureCooldownMs?: number
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
  private failure: { reason: 'tool-blocked' | 'error'; at: number; message: string } | null = null
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

  /** Prozesszustand plus Grund, warum die Suche nach Bedeutung gerade nicht geht. */
  getState(): SearchProcessState {
    return { phase: this.phase, reason: this.unavailableReason() }
  }

  private unavailableReason(): SearchUnavailableReason | null {
    if (this.deps.isProcessingActive()) return 'processing'
    if (!this.deps.resolveModel()) return 'model-missing'
    if (this.failure) return this.failure.reason
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
   * hat (Warteschlange leer, Modell installiert) — die Schleife des Suchindex
   * ruft das in ihrem Takt.
   */
  refreshState(): void {
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

  /**
   * Startet den Prozess, falls nötig (Single-Flight: parallele Aufrufe teilen
   * einen Start). Abgelehnt mit SearchWorkerUnavailableError, solange eine
   * Verarbeitung läuft oder ansteht, das Modell fehlt oder nach einem Absturz
   * die Pause noch läuft.
   */
  async ensureStarted(purpose: SearchWorkerStartPurpose): Promise<void> {
    for (;;) {
      const reason = this.unavailableReason()
      if (reason === 'processing' || reason === 'model-missing') {
        throw new SearchWorkerUnavailableError(reason)
      }
      if (this.failure) {
        const cooldown = this.deps.failureCooldownMs ?? SEARCH_WORKER_FAILURE_COOLDOWN_MS
        if (this.now() - this.failure.at < cooldown) {
          throw new SearchWorkerUnavailableError(this.failure.reason, this.failure.message)
        }
      }
      if (this.stopPromise) {
        await this.stopPromise
        continue
      }
      if (this.startPromise) {
        await this.startPromise
        return
      }
      if (this.proc && (this.phase === 'ready' || this.phase === 'busy')) {
        if (purpose !== 'index') this.resetIdle()
        return
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
      this.recordFailure('error', error instanceof Error ? error.message : String(error))
      throw new SearchWorkerUnavailableError('error', this.failure?.message)
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
          this.stopReason === 'processing' ? 'processing' : 'stopped'
        )
      }
      if (!this.failure) {
        this.recordFailure('error', error instanceof Error ? error.message : String(error))
      }
      throw new SearchWorkerUnavailableError(this.failure?.reason ?? 'error', this.failure?.message)
    }
    if (typeof ready.dim === 'number' && ready.dim !== model.dim) {
      this.recordFailure('error', `Suchmodell liefert ${ready.dim} statt ${model.dim} Dimensionen`)
      await this.stop('test')
      throw new SearchWorkerUnavailableError('error', this.failure?.message)
    }
    this.trackFootprint(ready)
    this.failure = null
    console.log(
      `[SearchWorker] bereit (${String(ready.device)}, ${String(ready.dtype)}, ${String(ready.load_ms)} ms, ${proc.weightsLine ?? '—'})`
    )
    this.setPhase('ready')
    this.resetIdle()
  }

  private recordFailure(reason: 'tool-blocked' | 'error', message: string): void {
    this.failure = { reason, at: this.now(), message }
  }

  private async onExit(proc: LineProcess, exit: LineProcessExit): Promise<void> {
    if (proc !== this.proc) return
    const expected = exit.stopRequested && !exit.startTimedOut
    if (!expected) {
      let reason: 'tool-blocked' | 'error' = 'error'
      if (exit.exitSignal === 'SIGKILL') {
        try {
          if (await this.deps.isToolBlocked?.(exit)) reason = 'tool-blocked'
        } catch {
          // Nachprüfung gescheitert — bleibt ein gewöhnlicher Fehler
        }
      }
      this.recordFailure(reason, describeExit(exit))
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
   * auch während des Startens; erfüllt sich erst, wenn der Prozess weg ist.
   */
  stop(reason: SearchWorkerStopReason): Promise<void> {
    this.clearIdle()
    const proc = this.proc
    if (!proc) return this.stopPromise ?? Promise.resolve()
    if (this.stopPromise) return this.stopPromise
    this.stopReason = reason
    this.setPhase('stopping')
    this.stopPromise = proc
      .stop()
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

  /** Beim Beenden der App: höchstens `timeoutMs` warten (danach hat LineProcess schon SIGKILL geschickt). */
  async shutdown(timeoutMs = 3_000): Promise<void> {
    await Promise.race([
      this.stop('quit'),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.())
    ])
  }

  private resetIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.inflight > 0) {
        this.resetIdle()
        return
      }
      console.log('[SearchWorker] 5 Minuten ohne Suche — Suchprozess wird beendet')
      void this.stop('idle')
    }, this.deps.idleMs ?? SEARCH_WORKER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private trackFootprint(message: Record<string, unknown>): void {
    const value = message.phys_footprint_bytes
    if (typeof value !== 'number') return
    this.lastFootprint = value
    this.peakFootprint = Math.max(this.peakFootprint, value)
    const limit = this.deps.restartFootprintBytes ?? SEARCH_WORKER_RESTART_FOOTPRINT_BYTES
    if (value > limit) this.restartPending = true
  }

  private async call(
    message: { op: string } & Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const proc = this.proc
    if (!proc || this.phase === 'stopping' || this.phase === 'stopped') {
      throw new SearchWorkerUnavailableError(this.unavailableReason() ?? 'stopped')
    }
    this.inflight++
    if (this.phase === 'ready') this.setPhase('busy')
    try {
      const response = await proc.request(message, { timeoutMs })
      this.trackFootprint(response)
      return response
    } catch (error) {
      if (error instanceof LineProcessTimeoutError) {
        // Ein Dienst ohne Antwort ist festgefahren: beenden, Pause bis zum nächsten Start
        this.recordFailure('error', error.message)
        void this.stop('timeout')
        throw new SearchWorkerUnavailableError('error', error.message)
      }
      if (error instanceof LineProcessExitedError) {
        await this.exitHandling
        throw new SearchWorkerUnavailableError(
          this.stopReason === 'processing'
            ? 'processing'
            : this.stopReason !== null
              ? 'stopped'
              : (this.failure?.reason ?? 'error'),
          error.message
        )
      }
      if (error instanceof LineProcessRequestError) {
        throw new Error(`Suchdienst: ${error.code}: ${error.message}`)
      }
      throw error
    } finally {
      this.inflight = Math.max(0, this.inflight - 1)
      if (this.inflight === 0 && this.proc === proc && this.phase === 'busy') {
        this.setPhase('ready')
        if (this.restartPending) {
          // Zwischen zwei Batches: Speicher zurückholen, der nächste Aufruf startet neu
          console.log(
            `[SearchWorker] phys_footprint ${this.lastFootprint} Bytes über der Grenze — Neustart`
          )
          this.restartPending = false
          void this.stop('memory')
        } else {
          this.resetIdle()
        }
      }
    }
  }

  /** Vektor einer Suchanfrage (normalisiert). Startet den Prozess bei Bedarf. */
  async embedQuery(text: string): Promise<Float32Array> {
    await this.ensureStarted('query')
    const model = this.model!
    const response = await this.call(
      { op: 'embed_query', text },
      this.deps.queryTimeoutMs ?? SEARCH_WORKER_QUERY_TIMEOUT_MS
    )
    return decodeVector(response.vector, model.dim)
  }

  /** Vektoren von Abschnitten (normalisiert), in der Reihenfolge der Texte. */
  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    await this.ensureStarted('index')
    const model = this.model!
    if (texts.length === 0) return []
    const response = await this.call(
      { op: 'embed_documents', texts },
      this.deps.batchTimeoutMs ?? SEARCH_WORKER_BATCH_TIMEOUT_MS
    )
    const vectors = response.vectors
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new Error('Suchdienst: Antwort mit falscher Anzahl Vektoren')
    }
    return vectors.map((v) => decodeVector(v, model.dim))
  }

  /** Modell des laufenden bzw. zuletzt gestarteten Prozesses. */
  get currentModel(): SearchModelInfo | null {
    return this.model
  }
}
