import type Database from 'better-sqlite3'
import { readFileSync, statSync } from 'fs'
import {
  SearchIndexRepository,
  type PendingTextSession
} from '../db/repositories/SearchIndexRepository'
import { walCheckpointTruncate } from '../db/maintenance'
import { buildSearchSections, type SearchSection } from './chunker'
import {
  SEARCH_DELETE_SLICE_MS,
  SEARCH_QUIET_WINDOW_MS,
  SEARCH_SLICE_MS,
  SEARCH_SLICE_PAUSE_MS,
  SEARCH_TEXT_PHASE_BATCH,
  SEARCH_TICK_MS
} from '../../shared/search-config'

/**
 * Hintergrundschleife des Suchindex (Epic #192 — #209, #210, #212; Bauplan
 * Abschnitt 5a). Nur Node, ohne Modell. Sie erledigt in Zeitscheiben von
 * höchstens SEARCH_SLICE_MS, mit einer echten Pause von SEARCH_SLICE_PAUSE_MS
 * dazwischen (der Main-Prozess bleibt reaktionsfähig, #210 AK 3), der Reihe
 * nach:
 *
 * 1. **Indexzeilen gelöschter Sitzungen entfernen** (#209 PC 1) — auch
 *    während einer Aufnahme: eine Sitzung ist ab der Markierung (deleting_at)
 *    unauffindbar; ihre Abschnitte werden einzeln gelöscht (mit FTS5
 *    'secure-delete' ~40 ms pro Abschnitt, eine 50-Minuten-Sitzung am Stück
 *    hätte bis zu 0.9 s blockiert). Danach schliesst `finishDeletion` das
 *    Löschen der Sitzung ab (Zeile, WAL-Checkpoint). Ohne laufende Schleife
 *    (Start, Tests) löscht SessionService am Stück.
 * 2. **Veraltete Textgenerationen entfernen** — eine Neuindexierung macht die
 *    neue Generation sofort aktiv, die alte ist über den Join auf `text_gen`
 *    unsichtbar und geht hier abschnittweise.
 * 3. **Dateistand prüfen** (einmal nach dem Start): Ein Absturz zwischen dem
 *    Schreiben des Dokuments und dem DB-Update in ReviewService.save
 *    hinterliesse einen veralteten Index; ein anderer Dateistand als beim
 *    Indexieren macht die Sitzung wieder «zu bearbeiten».
 * 4. **Textphase:** Dokument lesen, Abschnitte bilden, neue Generation samt
 *    FTS in einer Transaktion schreiben. Danach ist die exakte Suche (auch
 *    nach Klarnamen) aktuell — auch während einer Verarbeitung (#209 AK 18).
 *    Eine Sitzung wird erst SEARCH_QUIET_WINDOW_MS nach ihrer letzten
 *    Änderung bearbeitet (#212 OOS 1); Takt SEARCH_TICK_MS (#212 AK 2).
 *
 * Schritte 2–4 nie während einer Aufnahme (#209 AK 19, #212 AK 3): dieselben
 * Hook-Stellen wie die Pause der Warteschlange (recording-handlers). Was
 * aussteht, steht in der Datenbank und wird nach einem Neustart nachgeholt
 * (#212 AK 4, #210 PC 2). Die Vektorphase kommt mit PR S4.
 */

export interface SearchIndexServiceDeps {
  now?: () => number
  readDocument?: (path: string) => unknown
  /** Dateistand («Grösse:mtime») oder null, wenn die Datei fehlt. */
  statDocument?: (path: string) => string | null
  /**
   * Schliesst das Löschen einer markierten Sitzung ab, deren Indexzeilen weg
   * sind (SessionService.finishDeletion: Zeile löschen, WAL-Checkpoint).
   */
  finishDeletion?: (sessionId: string) => void
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

function defaultStatDocument(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return null
  }
}

export class SearchIndexService {
  private repository: SearchIndexRepository
  private now: () => number
  private readDocument: (path: string) => unknown
  private statDocument: (path: string) => string | null
  private finishDeletion: ((sessionId: string) => void) | null
  private interval: ReturnType<typeof setInterval> | null = null
  private continuation: ReturnType<typeof setTimeout> | null = null
  private recordingPaused = false
  private stopped = true
  private running = false
  private seeded = false
  /** Markierte Sitzungen → true, wenn danach finishDeletion folgt. */
  private purgeQueue = new Map<string, boolean>()
  private staleSessions = new Set<string>()
  private docChecks: Array<{ id: string; path: string; docStat: string | null }> | null = null

  constructor(
    private db: Database.Database,
    deps: SearchIndexServiceDeps = {}
  ) {
    this.repository = new SearchIndexRepository(db)
    this.now = deps.now ?? Date.now
    this.readDocument = deps.readDocument ?? defaultReadDocument
    this.statDocument = deps.statDocument ?? defaultStatDocument
    this.finishDeletion = deps.finishDeletion ?? null
  }

  /** Startet den Takt (beim App-Start nach den Recovery-Schritten). Idempotent. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.interval = setInterval(() => this.tick(), SEARCH_TICK_MS)
    this.interval.unref?.()
    // Erster Lauf gleich: Nachholen nach Neustart (#212 AK 4)
    this.scheduleContinuation(0)
  }

  /** true, solange die Schleife läuft — dann löscht SessionService gestaffelt. */
  isStarted(): boolean {
    return !this.stopped && this.finishDeletion !== null
  }

  /**
   * Hält die Schleife an: beim Beenden der App vor dem Schliessen der
   * Datenbank und vor einem Update-Tausch (#210 AK 7). Jeder Schritt läuft
   * synchron — nach der Rückkehr schreibt die Schleife nichts mehr.
   * Unterbrochenes Löschen schliesst `finishPendingDeletions` beim nächsten
   * Start ab. Idempotent; start() nimmt die Arbeit wieder auf.
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
    if (!paused) this.scheduleContinuation(0)
  }

  isRecordingPaused(): boolean {
    return this.recordingPaused
  }

  /**
   * Indexzeilen einer markierten Sitzung entfernen (#209 PC 1). `finish`:
   * danach das Löschen der Sitzung abschliessen (ihre Dateien sind weg).
   */
  schedulePurge(sessionId: string, finish: boolean): void {
    this.purgeQueue.set(sessionId, finish || this.purgeQueue.get(sessionId) === true)
    this.scheduleContinuation(0)
  }

  private scheduleContinuation(delayMs: number): void {
    if (this.continuation || this.stopped) return
    this.continuation = setTimeout(() => {
      this.continuation = null
      this.tick()
    }, delayMs)
    this.continuation.unref?.()
  }

  /** Ein Takt; bei weiterer Arbeit folgt die nächste Scheibe nach einer Pause. */
  tick(): void {
    if (this.stopped) return
    let more = false
    try {
      more = this.runSlice().more
    } catch (error) {
      console.error(
        '[Search] Aufbereitung fehlgeschlagen — nächster Versuch im nächsten Takt:',
        error
      )
    }
    if (more) this.scheduleContinuation(SEARCH_SLICE_PAUSE_MS)
  }

  /**
   * Eine Zeitscheibe, synchron (öffentlich für Tests und Messungen). Jeder
   * Schritt macht mindestens einen Arbeitsschritt, prüft danach die
   * Restzeit — ein einzelner sehr grosser Arbeitsschritt (eine riesige
   * Sitzung) darf das Budget überschreiten, danach folgt die Pause.
   */
  runSlice(budgetMs = SEARCH_SLICE_MS): { more: boolean } {
    if (this.running) return { more: false }
    this.running = true
    const started = performance.now()
    const deadline = started + budgetMs
    const left = (): boolean => performance.now() < deadline
    // Löschen im FTS-Index: das Commit danach kostet noch einmal ~25–50 ms
    // (Indexseiten in den WAL schreiben) — deshalb ein eigenes, kleineres
    // Budget, und nach einer Lösch-Scheibe nichts anderes mehr.
    const deleteDeadline = started + Math.min(budgetMs, SEARCH_DELETE_SLICE_MS)
    const leftForDeletes = (): boolean => performance.now() < deleteDeadline
    try {
      this.seedOnce()
      if (this.purgeQueue.size > 0) {
        return { more: this.purgeDeleted(leftForDeletes) || this.hasBackgroundWork() }
      }
      if (this.recordingPaused) return { more: false }
      if (this.staleSessions.size > 0) {
        return { more: this.cleanupStale(leftForDeletes) || this.hasBackgroundWork() }
      }
      let more = this.checkDocStats(left)
      if (!left()) return { more: true }
      more = this.textSlice(left, SEARCH_TEXT_PHASE_BATCH).more || more
      // Eine Neuindexierung hinterlässt eine veraltete Generation
      return { more: more || this.staleSessions.size > 0 }
    } finally {
      this.running = false
    }
  }

  /** Noch etwas zu tun, das nicht auf das ruhige Fenster wartet? */
  private hasBackgroundWork(): boolean {
    if (this.purgeQueue.size > 0) return true
    if (this.recordingPaused) return false
    return (
      this.staleSessions.size > 0 ||
      this.docChecks === null ||
      this.docChecks.length > 0 ||
      this.repository.hasPendingText(new Date(this.now() - SEARCH_QUIET_WINDOW_MS).toISOString())
    )
  }

  /** Schleife bis zum Ende treiben (Tests): gibt die Zahl der Scheiben zurück. */
  drain(maxSlices = 100_000, budgetMs = SEARCH_SLICE_MS): number {
    for (let i = 1; i <= maxSlices; i++) {
      if (!this.runSlice(budgetMs).more) return i
    }
    throw new Error('Aufbereitung für die Suche wird nicht fertig')
  }

  /** Nach einem Neustart: was ein Absturz oder Beenden unterbrochen hat. */
  private seedOnce(): void {
    if (this.seeded) return
    this.seeded = true
    for (const id of this.repository.findSessionsWithStaleChunks()) this.staleSessions.add(id)
    // Markierte Sitzungen mit Indexzeilen, deren Dateien nicht weg sind: ihre
    // Indexzeilen gehen trotzdem; das Löschen schliesst der nächste Start ab.
    for (const id of this.repository.findMarkedSessionsWithChunks()) {
      if (!this.purgeQueue.has(id)) this.purgeQueue.set(id, false)
    }
  }

  /**
   * Löscht Abschnitte in EINER Transaktion pro Scheibe: FTS5 schreibt beim
   * Löschen viele Indexseiten, die sich Abschnitte derselben Sitzung teilen —
   * gebündelt kostet ein Abschnitt etwa ein Drittel (gemessen 10 statt 30 ms).
   */
  private purgeDeleted(left: () => boolean): boolean {
    if (this.purgeQueue.size === 0) return false
    const finished: Array<[string, boolean]> = []
    let outOfTime = false
    this.db.transaction(() => {
      for (const [sessionId, finish] of this.purgeQueue) {
        for (;;) {
          const chunk = this.repository.findAnyChunk(sessionId)
          if (chunk === null) {
            this.purgeQueue.delete(sessionId)
            this.staleSessions.delete(sessionId)
            finished.push([sessionId, finish])
            break
          }
          this.repository.deleteChunk(chunk)
          if (!left()) {
            outOfTime = true
            return
          }
        }
      }
    })()
    // Ausserhalb der Transaktion: finishDeletion checkpointet den WAL
    for (const [sessionId, finish] of finished) this.finishPurge(sessionId, finish)
    return outOfTime || this.purgeQueue.size > 0
  }

  private finishPurge(sessionId: string, finish: boolean): void {
    try {
      if (finish && this.finishDeletion) {
        this.finishDeletion(sessionId)
        return
      }
      this.repository.deleteState(sessionId)
      if (!walCheckpointTruncate(this.db)) {
        console.error('[Search] WAL-Checkpoint nach dem Entfernen der Indexzeilen blockiert')
      }
    } catch (error) {
      console.error(`[Search] Löschen der Sitzung ${sessionId} nicht abgeschlossen:`, error)
    }
  }

  private cleanupStale(left: () => boolean): boolean {
    if (this.staleSessions.size === 0) return false
    let outOfTime = false
    this.db.transaction(() => {
      for (const sessionId of this.staleSessions) {
        for (;;) {
          const chunk = this.repository.findStaleChunk(sessionId)
          if (chunk === null) {
            this.staleSessions.delete(sessionId)
            break
          }
          this.repository.deleteChunk(chunk)
          if (!left()) {
            outOfTime = true
            return
          }
        }
      }
    })()
    return outOfTime || this.staleSessions.size > 0
  }

  private checkDocStats(left: () => boolean): boolean {
    if (this.docChecks === null) this.docChecks = this.repository.findIndexedDocStats()
    while (this.docChecks.length > 0) {
      const item = this.docChecks.pop()!
      if (item.docStat !== null) {
        const current = this.statDocument(item.path)
        if (current !== null && current !== item.docStat) {
          console.log(`[Search] Dokument der Sitzung ${item.id} geändert — wird neu indexiert`)
          this.repository.markTextStale(item.id)
        }
      }
      if (!left()) return this.docChecks.length > 0
    }
    return false
  }

  /**
   * Nur die Textphase, synchron: bis zu `limit` Sitzungen bzw. `budgetMs`.
   * Öffentlich für Tests und den Abnahmetest (PR S6). Nie während einer
   * Aufnahme.
   */
  runTextPhase(limit = SEARCH_TEXT_PHASE_BATCH, budgetMs = SEARCH_SLICE_MS): TextPhaseResult {
    if (this.recordingPaused || this.running) return { indexed: 0, more: false }
    this.running = true
    try {
      const deadline = performance.now() + budgetMs
      return this.textSlice(() => performance.now() < deadline, limit)
    } finally {
      this.running = false
    }
  }

  private textSlice(left: () => boolean, limit: number): TextPhaseResult {
    const quietBefore = new Date(this.now() - SEARCH_QUIET_WINDOW_MS).toISOString()
    const pending = this.repository.findPendingText(quietBefore, limit + 1)
    let indexed = 0
    let done = 0
    for (const session of pending.slice(0, limit)) {
      // Restzeit VOR dem Lesen der nächsten Sitzung prüfen; eine pro Scheibe immer
      if (done > 0 && !left()) break
      if (this.indexSession(session)) indexed++
      done++
    }
    return { indexed, more: pending.length > done }
  }

  private indexSession(session: PendingTextSession): boolean {
    let document: unknown = null
    let error: string | null = null
    let docStat: string | null = null
    if (session.anonymizedPath) {
      docStat = this.statDocument(session.anonymizedPath)
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
    const gen = this.repository.writeTextGeneration(
      session.id,
      session.searchRev,
      sections,
      error,
      docStat
    )
    if (gen === null) return false
    // Die vorige Generation räumt die Schleife abschnittweise weg
    if (gen > 1) this.staleSessions.add(session.id)
    return true
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

/** Nur für Tests: Singleton zurücksetzen. */
export function resetSearchIndexServiceForTests(): void {
  instance?.stop()
  instance = null
}
