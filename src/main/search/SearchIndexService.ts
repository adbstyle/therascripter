import type Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import {
  SearchIndexRepository,
  type PendingTextSession
} from '../db/repositories/SearchIndexRepository'
import { buildSearchSections, type SearchSection } from './chunker'
import {
  SEARCH_QUIET_WINDOW_MS,
  SEARCH_TEXT_PHASE_BATCH,
  SEARCH_TEXT_PHASE_SLICE_MS,
  SEARCH_TICK_MS
} from '../../shared/search-config'

/**
 * Aufbereitung für die Suche, Textphase (Epic #192 — #209, #210, #212;
 * Bauplan Abschnitt 5a). Nur Node, ohne Modell: Dokument lesen, Abschnitte
 * bilden, neue Textgeneration samt FTS in einer Transaktion schreiben. Danach
 * ist die exakte Suche (auch nach Klarnamen) aktuell — auch während einer
 * Verarbeitung (#209 AK 18). Die Vektorphase kommt mit PR S4.
 *
 * - Takt alle SEARCH_TICK_MS; bearbeitet wird eine Sitzung erst
 *   SEARCH_QUIET_WINDOW_MS nach ihrer letzten Änderung (#212 OOS 1). Beides
 *   zusammen hält die Frist von einer Minute (#212 AK 2).
 * - Nie während einer Aufnahme (#209 AK 19, #212 AK 3): dieselben Hook-Stellen
 *   wie die Pause der Warteschlange (recording-handlers).
 * - Kein eigener Fortschritt, kein Zustand über einen Neustart hinaus: was
 *   aussteht, steht in der Datenbank (search_rev > text_rev bzw. keine Zeile)
 *   und wird nach dem nächsten Start nachgeholt (#212 AK 4, #210 PC 2).
 * - Arbeitet in Scheiben von höchstens SEARCH_TEXT_PHASE_BATCH Sitzungen bzw.
 *   SEARCH_TEXT_PHASE_SLICE_MS und gibt dazwischen die Event-Loop frei; der Bestand nach dem Update läuft so
 *   ohne spürbare Blockade durch (#210 AK 3).
 */

export interface SearchIndexServiceDeps {
  now?: () => number
  readDocument?: (path: string) => unknown
}

export interface TextPhaseResult {
  /** Sitzungen mit neuer Textgeneration. */
  indexed: number
  /** true, wenn in diesem Lauf nicht alles Fällige bearbeitet wurde. */
  more: boolean
}

function defaultReadDocument(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export class SearchIndexService {
  private repository: SearchIndexRepository
  private now: () => number
  private readDocument: (path: string) => unknown
  private interval: ReturnType<typeof setInterval> | null = null
  private continuation: ReturnType<typeof setTimeout> | null = null
  private recordingPaused = false
  private stopped = true
  private running = false

  constructor(db: Database.Database, deps: SearchIndexServiceDeps = {}) {
    this.repository = new SearchIndexRepository(db)
    this.now = deps.now ?? Date.now
    this.readDocument = deps.readDocument ?? defaultReadDocument
  }

  /** Startet den Takt (beim App-Start nach den Recovery-Schritten). Idempotent. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.interval = setInterval(() => this.tick(), SEARCH_TICK_MS)
    this.interval.unref?.()
    // Erster Lauf gleich: Nachholen nach Neustart (#212 AK 4)
    this.scheduleContinuation()
  }

  /**
   * Hält die Aufbereitung an: beim Beenden der App vor dem Schliessen der
   * Datenbank und vor einem Update-Tausch (#210 AK 7). Eine Textphase läuft
   * synchron in einer Transaktion — nach der Rückkehr dieser Methode schreibt
   * sie nichts mehr. Idempotent; start() nimmt sie wieder auf.
   */
  stop(): void {
    this.stopped = true
    if (this.interval) clearInterval(this.interval)
    if (this.continuation) clearTimeout(this.continuation)
    this.interval = null
    this.continuation = null
  }

  /** Anhalten vor einem Update-Tausch — dieselbe Wirkung wie stop(). */
  stopForUpdate(): Promise<void> {
    this.stop()
    return Promise.resolve()
  }

  /** Aufnahme läuft: keine Aufbereitung; danach holt der nächste Takt alles nach. */
  setRecordingPause(paused: boolean): void {
    this.recordingPaused = paused
    if (!paused && !this.stopped) this.scheduleContinuation()
  }

  isRecordingPaused(): boolean {
    return this.recordingPaused
  }

  private scheduleContinuation(): void {
    if (this.continuation || this.stopped) return
    this.continuation = setTimeout(() => {
      this.continuation = null
      this.tick()
    }, 0)
    this.continuation.unref?.()
  }

  /** Ein Takt; bei weiterer Arbeit folgt die nächste Scheibe nach einem Event-Loop-Durchgang. */
  tick(): void {
    if (this.stopped || this.recordingPaused || this.running) return
    let result: TextPhaseResult
    try {
      result = this.runTextPhase()
    } catch (error) {
      console.error('[Search] Textphase fehlgeschlagen — nächster Versuch im nächsten Takt:', error)
      return
    }
    if (result.more) this.scheduleContinuation()
  }

  /**
   * Eine Scheibe der Textphase, synchron. Öffentlich für Tests und den
   * Abnahmetest (PR S6). Läuft nie während einer Aufnahme.
   */
  runTextPhase(limit = SEARCH_TEXT_PHASE_BATCH): TextPhaseResult {
    if (this.recordingPaused || this.running) return { indexed: 0, more: false }
    this.running = true
    try {
      const quietBefore = new Date(this.now() - SEARCH_QUIET_WINDOW_MS).toISOString()
      const pending = this.repository.findPendingText(quietBefore, limit + 1)
      const started = performance.now()
      let indexed = 0
      let done = 0
      for (const session of pending.slice(0, limit)) {
        if (this.indexSession(session)) indexed++
        done++
        if (performance.now() - started >= SEARCH_TEXT_PHASE_SLICE_MS) break
      }
      return { indexed, more: pending.length > done }
    } finally {
      this.running = false
    }
  }

  private indexSession(session: PendingTextSession): boolean {
    let document: unknown = null
    let error: string | null = null
    if (session.anonymizedPath) {
      try {
        document = this.readDocument(session.anonymizedPath)
      } catch (e) {
        // Titel und Zusammenfassung bleiben auffindbar; die nächste Änderung
        // versucht es erneut (Bauplan 5a).
        error = `Dokument nicht lesbar: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    let sections: SearchSection[]
    try {
      sections = buildSearchSections({
        type: session.type,
        title: session.titlePlain,
        summary: session.summaryPlain,
        document
      })
    } catch (e) {
      error = `Abschnitte nicht gebildet: ${e instanceof Error ? e.message : String(e)}`
      sections = buildSearchSections({
        type: session.type,
        title: session.titlePlain,
        summary: session.summaryPlain,
        document: null
      })
    }
    if (error) console.error(`[Search] Sitzung ${session.id}: ${error}`)
    return this.repository.writeTextGeneration(session.id, session.searchRev, sections, error)
  }
}

let instance: SearchIndexService | null = null

export function initSearchIndexService(
  db: Database.Database,
  deps?: SearchIndexServiceDeps
): SearchIndexService {
  instance?.stop()
  instance = new SearchIndexService(db, deps)
  return instance
}

/** null, solange die Aufbereitung nicht initialisiert ist (Tests, früher Start). */
export function getSearchIndexService(): SearchIndexService | null {
  return instance
}
