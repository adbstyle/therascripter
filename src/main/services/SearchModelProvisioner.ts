import type { ModelDefinition } from '../../shared/model-catalog'
import type { SearchModelFailureReason, SearchModelState } from '../../shared/types/Search'
import { modelStagingBytes } from '../../shared/update-bundle'
import type { ModelInstallOptions, ModelInstallResult } from './ModelDownloadService'

/**
 * Wartezeiten nach dem 1., 2. und 3. gescheiterten Versuch (#210 PC 1). Danach
 * gilt der Download als gescheitert (`failed`) und läuft still alle
 * `LONG_RETRY_MS` weiter.
 */
export const SEARCH_MODEL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const
export const SEARCH_MODEL_LONG_RETRY_MS = 6 * 60 * 60_000
/** Während einer Aufnahme oder Verarbeitung: so lange warten und neu prüfen. */
export const SEARCH_MODEL_BUSY_RECHECK_MS = 60_000

export interface SearchModelProvisionerDeps {
  /** Katalogeintrag des Suchmodells (auch unveröffentlicht); null = keine Suche. */
  getModel: () => ModelDefinition | null
  isPublished: (def: ModelDefinition) => boolean
  /** Liegt das Modell vollständig da (READY)? Unabhängig vom Schalter. */
  isInstalled: () => boolean
  /**
   * Ersteinrichtung abgeschlossen? Vorher lädt der Ersteinrichtungs-Bildschirm
   * das Suchmodell mit — der Provisioner lädt nie parallel dazu.
   */
  setupComplete: () => boolean
  /**
   * Läuft eine Aufnahme oder Verarbeitung? Dann beginnt kein neuer Versuch:
   * Download und Entpacken bremsen auf 8-GB-Macs die Verarbeitung (wie beim
   * Update). Ein laufender Download läuft weiter.
   */
  isBusy: () => boolean
  /** Freier Platz im Modellordner; null = unbekannt. */
  freeBytes: () => number | null
  /** Lädt, prüft und entpackt (installCatalogModel). Zählt NICHT als Arbeit im WorkGuard. */
  install: (def: ModelDefinition, opts: ModelInstallOptions) => Promise<ModelInstallResult>
  /** Entfernt Archiv- und `.partial`-Reste eines Downloads, der nicht mehr gebraucht wird. */
  removeLeftovers: (def: ModelDefinition) => void
  onStateChange: (state: SearchModelState) => void
  now: () => Date
  log: (message: string) => void
  /**
   * Meldet das Aufwachen des Macs (powerMonitor 'resume'). Ein im Ruhezustand
   * fällig gewordener Versuch läuft dann sofort statt erst, wenn der Timer
   * irgendwann nachzieht.
   */
  subscribeResume?: (listener: () => void) => void
}

/**
 * Stellt das Suchmodell bereit (Epic #192, #209 AK 21, #210 AK 2–5/7, PC 1).
 *
 * Pflicht bei der Ersteinrichtung, aber kein Aussperren: fehlt das Modell
 * (Bestandsnutzer nach dem Update, gescheiterter Download in der
 * Ersteinrichtung), lädt es dieser Dienst im Hintergrund nach — nach dem Start
 * und nach der Ersteinrichtung, mit Wiederholung nach 1, 5 und 30 Minuten,
 * danach alle 6 Stunden, und jederzeit auf «Erneut versuchen».
 *
 * Single-Flight: es läuft höchstens ein Versuch; ein zweiter Anstoss wartet
 * auf denselben. Der Download zählt bewusst NICHT als Arbeit im WorkGuard
 * (#210 AK 7): ein Update-Austausch beendet die App, `stop()` bricht den
 * Download ab, und der nächste Start setzt am `.partial` fort (bzw. räumt die
 * Reste weg, wenn das Update das Modell schon mitgebracht hat).
 */
export class SearchModelProvisioner {
  private state: SearchModelState
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private signal: { aborted: boolean } | null = null
  private stopped = false
  /** Zeitpunkt (ms) des geplanten nächsten Versuchs; null = keiner geplant. */
  private dueAt: number | null = null

  constructor(private readonly deps: SearchModelProvisionerDeps) {
    this.state = this.passiveState()
    deps.subscribeResume?.(() => this.handleResume())
  }

  /** Nach dem Aufwachen: ein inzwischen fälliger Versuch läuft sofort. */
  handleResume(): void {
    if (this.stopped || this.dueAt === null) return
    if (this.deps.now().getTime() >= this.dueAt) void this.ensure()
  }

  getState(): SearchModelState {
    return this.state
  }

  /** Nach dem App-Start und nach der Ersteinrichtung: fehlt das Modell, laden. */
  start(): void {
    this.stopped = false
    void this.ensure()
  }

  /** «Erneut versuchen» (#210 AK 5): sofort, die Wartestaffel beginnt von vorn. */
  async retryNow(): Promise<SearchModelState> {
    this.stopped = false
    if (!this.running) this.failures = 0
    await this.ensure()
    return this.state
  }

  /** Beim Beenden (runQuitCleanup): Timer weg, laufenden Download abbrechen. */
  stop(): void {
    this.stopped = true
    this.clearTimer()
    if (this.signal) this.signal.aborted = true
  }

  /** Zustand ohne Versuch — für den Start, bevor etwas passiert ist. */
  private passiveState(): SearchModelState {
    const def = this.deps.getModel()
    if (def && this.deps.isInstalled()) return { status: 'ready' }
    if (!def || !this.deps.isPublished(def)) return { status: 'unpublished' }
    // Fehlt und ist veröffentlicht: geladen wird erst beim echten Start
    if (!this.deps.setupComplete()) return { status: 'waiting', reason: 'setup' }
    return { status: 'waiting', reason: 'starting' }
  }

  private ensure(): Promise<void> {
    if (!this.running) {
      this.running = this.attempt().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async attempt(): Promise<void> {
    this.clearTimer()
    const def = this.deps.getModel()

    if (def && this.deps.isInstalled()) {
      // Auch vom Update oder von Hand gebracht: Reste eines eigenen Downloads weg
      this.tryRemoveLeftovers(def)
      this.failures = 0
      this.setState({ status: 'ready' })
      return
    }
    if (!def || !this.deps.isPublished(def)) {
      this.setState({ status: 'unpublished' })
      return
    }
    if (this.stopped) return
    // Die Ersteinrichtung lädt es selbst und stösst uns danach an
    if (!this.deps.setupComplete()) {
      this.setState({ status: 'waiting', reason: 'setup' })
      return
    }
    if (this.deps.isBusy()) {
      this.schedule(SEARCH_MODEL_BUSY_RECHECK_MS)
      this.setState({
        status: 'waiting',
        reason: 'busy',
        nextAttemptAt: new Date(this.dueAt!).toISOString()
      })
      return
    }

    // Archiv und entpacktes Modell liegen kurz nebeneinander (wie beim Update)
    const need = modelStagingBytes({ sizeBytes: def.sizeBytes, archive: def.archive === true })
    const free = this.deps.freeBytes()
    if (free !== null && free < need) {
      this.fail('disk-space', `frei ${free} B, nötig ${need} B`)
      return
    }

    const signal = { aborted: false }
    this.signal = signal
    this.setState({ status: 'downloading', progress: 0 })
    let result: ModelInstallResult
    try {
      result = await this.deps.install(def, {
        signal,
        // Beim Beenden auch tar beenden — READY zuletzt trägt die Selbstheilung
        abortExtraction: true,
        onProgress: (p) => {
          const progress = Math.max(0, Math.min(100, Math.round(p.percent)))
          if (this.state.status === 'downloading' && this.state.progress === progress) return
          this.setState({ status: 'downloading', progress })
        }
      })
    } catch (err) {
      result = {
        ok: false,
        reason: 'unknown',
        error: err instanceof Error ? err.message : `${err}`
      }
    } finally {
      this.signal = null
    }

    if (signal.aborted || (!result.ok && result.reason === 'aborted')) {
      this.deps.log('SearchModel: Download abgebrochen')
      return
    }
    if (result.ok && result.installed) {
      this.failures = 0
      this.deps.log('SearchModel: bereit')
      this.setState({ status: 'ready' })
      return
    }
    if (result.ok) {
      this.fail('extract', 'nach dem Entpacken fehlt die Markierung READY')
      return
    }
    this.fail(result.reason as SearchModelFailureReason, result.error)
  }

  private fail(reason: SearchModelFailureReason, detail: string): void {
    this.failures++
    this.deps.log(`SearchModel: Versuch ${this.failures} gescheitert (${reason}): ${detail}`)
    if (this.stopped) return
    const short = this.failures <= SEARCH_MODEL_RETRY_DELAYS_MS.length
    const delay = short
      ? SEARCH_MODEL_RETRY_DELAYS_MS[this.failures - 1]
      : SEARCH_MODEL_LONG_RETRY_MS
    this.schedule(delay)
    this.setState(
      short
        ? {
            status: 'retry-scheduled',
            reason,
            nextAttemptAt: new Date(this.dueAt!).toISOString()
          }
        : { status: 'failed', reason }
    )
  }

  private tryRemoveLeftovers(def: ModelDefinition): void {
    try {
      this.deps.removeLeftovers(def)
    } catch (err) {
      this.deps.log(
        `SearchModel: Reste nicht entfernt: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  private schedule(delay: number): void {
    this.clearTimer()
    this.dueAt = this.deps.now().getTime() + delay
    this.timer = setTimeout(() => void this.ensure(), delay)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dueAt = null
  }

  private setState(next: SearchModelState): void {
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    this.deps.onStateChange(next)
  }
}
