import type Database from 'better-sqlite3'
import { SearchIndexRepository, type StoredChunk } from '../db/repositories/SearchIndexRepository'
import { SearchRecentRepository } from '../db/repositories/SearchRecentRepository'
import { SEARCH_SORT_DAY, SEARCH_VISIBLE_SESSION } from '../db/repositories/SearchIndexRepository'
import { findExactCandidates, parseQuery, queryWords, type ExactSearchResult } from './exactSearch'
import { filterAndLimit, rankDocuments, type ChunkCandidate, type RankedDocument } from './ranking'
import { buildHit } from './snippet'
import { SearchWorkerUnavailableError, type SearchWorkerFailure } from './SearchWorker'
import { VectorStoreCancelledError, type ScoredChunk, type VectorStore } from './VectorStore'
import type { SearchModelInfo } from './searchModel'
import { normalizeSearchText } from '../../shared/utils/search-normalize'
import {
  SEARCH_MAX_DOCUMENT_RESULTS,
  SEARCH_MAX_DOSSIER_RESULTS,
  SEARCH_SEMANTIC_THRESHOLD
} from '../../shared/search-config'
import type { DossierRef } from '../../shared/types/Dossier'
import type { SessionType } from '../../shared/types'
import type {
  RecentSearchQuery,
  SearchDocumentResult,
  SearchDossierResult,
  SearchQueryInput,
  SearchQueryResult,
  SearchProcessState,
  SearchScope,
  SemanticSearchStatus
} from '../../shared/types/Search'

/**
 * Suche im Main-Prozess (Epic #192 — #209, #211; Bauplan Abschnitt 6).
 *
 * Zwei Stufen:
 * 1. `query` (synchron): Patientendossiers und exakte Treffer; `semantic`
 *    sagt, ob die Suche nach Bedeutung folgt ('pending') oder warum nicht.
 * 2. `semantic` (asynchron): Anfrage einbetten, Kosinus gegen alle
 *    Abschnitte im Vektorspeicher, alle ≥ SEARCH_SEMANTIC_THRESHOLD (kein
 *    globaler Top-K-Schnitt), zusammen mit den exakten Treffern gerankt —
 *    exakte zuerst, innerhalb nach Kosinus (`ranking.ts`). Der Filter auf ein
 *    Patientendossier kommt NACH dem Ranking (#211 AK 3).
 */

/** Was die Suche nach Bedeutung braucht — der Suchprozess und der Vektorspeicher. */
export interface SemanticSearchDeps {
  embedQuery: (text: string) => Promise<Float32Array>
  getState: () => SearchProcessState
  /**
   * Grund aus Sicht einer USER-Suche (SearchWorker.getUserReason): ohne die
   * angehaltenen Starts der Aufbereitung. Default: getState().reason.
   */
  getUserReason?: () => SearchProcessState['reason']
  store: VectorStore
  resolveModel: () => SearchModelInfo | null
  /** Default SEARCH_SEMANTIC_THRESHOLD. */
  threshold?: number
}

export interface SearchServiceDeps {
  /** Suche nach Bedeutung; ohne: `semantic` meldet 'model-missing'. */
  semantic?: SemanticSearchDeps
  /** Obergrenze der Treffer-Abschnitte (Tests); Default SEARCH_MAX_CANDIDATE_CHUNKS. */
  maxCandidates?: number
}

export interface SemanticQueryOptions {
  /** true, sobald eine neuere Anfrage desselben Fensters diese abgelöst hat. */
  isSuperseded?: () => boolean
}

/** Grund aus dem Prozesszustand → Stand in der Antwort. */
export function semanticStatusOf(
  reason: SearchProcessState['reason'] | SearchWorkerFailure
): SemanticSearchStatus {
  switch (reason) {
    case null:
      return 'pending'
    case 'processing':
      return 'unavailable-processing'
    case 'model-missing':
      return 'model-missing'
    case 'tool-blocked':
      return 'tool-blocked'
    default:
      return 'error'
  }
}

interface DossierRow {
  id: string
  first_name: string
  last_name: string
  external_id: string | null
  birth_date: string | null
}

function rowToRef(row: DossierRow): DossierRef {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    externalId: row.external_id,
    birthDate: row.birth_date
  }
}

interface SessionMetaRow {
  id: string
  type: SessionType
  title: string
  title_plain: string | null
}

export class SearchService {
  private index: SearchIndexRepository
  private recent: SearchRecentRepository
  private semanticDeps: SemanticSearchDeps | null
  private maxCandidates: number | undefined

  constructor(
    private db: Database.Database,
    deps: SearchServiceDeps = {}
  ) {
    this.index = new SearchIndexRepository(db)
    this.recent = new SearchRecentRepository(db)
    this.semanticDeps = deps.semantic ?? null
    this.maxCandidates = deps.maxCandidates
  }

  /** Stand der Suche nach Bedeutung, wie `search:query` ihn meldet. */
  semanticStatus(): SemanticSearchStatus {
    if (!this.semanticDeps) return 'model-missing'
    return semanticStatusOf(this.userReason())
  }

  private userReason(): SearchProcessState['reason'] {
    const deps = this.semanticDeps!
    return deps.getUserReason ? deps.getUserReason() : deps.getState().reason
  }

  query(input: SearchQueryInput): SearchQueryResult {
    const { documents, truncated, terms } = this.rankExact(input.query, input.scope)
    return {
      requestId: input.requestId,
      // Dossier-Treffer gibt es auch in einer Dossier-Suche nicht — dort sucht
      // der USER in den Inhalten genau eines Dossiers (#211).
      dossiers: input.scope.kind === 'all' ? this.findDossiers(input.query) : [],
      results: this.buildResults(documents, terms),
      truncated,
      semantic: this.semanticStatus()
    }
  }

  /**
   * Exakte Treffer, gerankt und auf SEARCH_MAX_DOCUMENT_RESULTS geschnitten.
   * Bei einer Dossier-Suche filtert schon die Abfrage auf die Sitzungen, die
   * dem Dossier JETZT zugeordnet sind (#211 AK 1) — vor den Obergrenzen.
   * Reihenfolge: dieselbe Vergleichsfunktion wie über alle Inhalte; solange
   * keine Grenze greift, sind es genau die Treffer der Gesamtsuche aus diesem
   * Dossier in derselben Reihenfolge (#211 AK 3). Öffentlich für PR S4 und den
   * Abnahmetest.
   */
  rankExact(
    query: string,
    scope: SearchScope
  ): { documents: RankedDocument[]; truncated: boolean; terms: string[] } {
    const { exact, terms } = this.exactCandidates(query, scope)
    const ranked = rankDocuments(exact.candidates, (id) => exact.sortDays.get(id) ?? '')
    const { documents, truncated } = filterAndLimit(ranked, null, SEARCH_MAX_DOCUMENT_RESULTS)
    return { documents, truncated: truncated || exact.capped, terms }
  }

  private exactCandidates(
    query: string,
    scope: SearchScope
  ): { exact: ExactSearchResult; terms: string[] } {
    const parsed = parseQuery(query)
    const exact = findExactCandidates(this.db, parsed, {
      dossierId: scope.kind === 'dossier' ? scope.dossierId : undefined,
      maxCandidates: this.maxCandidates
    })
    return { exact, terms: parsed.terms }
  }

  /**
   * Interne Abschnitts-Rangfolge der Suche nach Bedeutung (für den
   * Abnahmetest in PR S6): Kosinus der Anfrage gegen alle Abschnitte im
   * Vektorspeicher, absteigend; `threshold` null = vor der Schwelle (so ist
   * der Zielwert von #209 AK 13 definiert).
   */
  async rankChunks(
    query: string,
    options: { threshold?: number | null; isCancelled?: () => boolean } = {}
  ): Promise<ScoredChunk[]> {
    const deps = this.semanticDeps
    if (!deps) throw new SearchWorkerUnavailableError('model-missing')
    const model = deps.resolveModel()
    if (!model) throw new SearchWorkerUnavailableError('model-missing')
    // Modellstart und Laden der Vektoren laufen parallel (Bauplan 5b)
    const [vector] = await Promise.all([deps.embedQuery(query), deps.store.load(model.modelId)])
    return deps.store.score(vector, {
      threshold:
        options.threshold === undefined
          ? (deps.threshold ?? SEARCH_SEMANTIC_THRESHOLD)
          : options.threshold,
      isCancelled: options.isCancelled
    })
  }

  /**
   * Suche nach Bedeutung samt exakten Treffern (`search:semantic`). Ist sie
   * nicht verfügbar (Verarbeitung, Modell fehlt, …), liefert sie die exakten
   * Treffer mit dem Grund in `semantic` — der Renderer kann die Antwort immer
   * übernehmen. Eine abgelöste Anfrage endet am nächsten Haltepunkt mit
   * 'superseded', ohne den Suchprozess weiter zu beschäftigen.
   */
  async semantic(
    input: SearchQueryInput,
    options: SemanticQueryOptions = {}
  ): Promise<SearchQueryResult> {
    const { exact, terms } = this.exactCandidates(input.query, input.scope)
    const exactOnly = (semantic: SemanticSearchStatus): SearchQueryResult => {
      const ranked = rankDocuments(exact.candidates, (id) => exact.sortDays.get(id) ?? '')
      const { documents, truncated } = filterAndLimit(ranked, null, SEARCH_MAX_DOCUMENT_RESULTS)
      return {
        requestId: input.requestId,
        dossiers: input.scope.kind === 'all' ? this.findDossiers(input.query) : [],
        results: this.buildResults(documents, terms),
        truncated: truncated || exact.capped,
        semantic
      }
    }
    // Nur Verarbeitung und fehlendes Modell schliessen einen Versuch aus; nach
    // einem Fehler versucht die Anfrage (nach der Pause) einen Neustart
    const status = this.semanticStatus()
    if (status === 'unavailable-processing' || status === 'model-missing') return exactOnly(status)
    const isSuperseded = options.isSuperseded ?? ((): boolean => false)
    if (isSuperseded()) return exactOnly('superseded')

    let scored: ScoredChunk[]
    try {
      scored = await this.rankChunks(input.query, { isCancelled: isSuperseded })
    } catch (error) {
      if (error instanceof VectorStoreCancelledError) return exactOnly('superseded')
      if (error instanceof SearchWorkerUnavailableError) {
        const reason = error.reason === 'stopped' ? this.userReason() : error.reason
        return exactOnly(reason === null ? 'error' : semanticStatusOf(reason))
      }
      console.error('[Search] Suche nach Bedeutung fehlgeschlagen:', error)
      return exactOnly('error')
    }
    if (isSuperseded()) return exactOnly('superseded')

    // Nur sichtbare Sitzungen (fertig verarbeitet, nicht im Löschen) — der
    // Vektorspeicher wird synchron nachgeführt, das hier ist die zweite Sicherung
    const sortDays = new Map(exact.sortDays)
    const missing = [...new Set(scored.map((c) => c.sessionId))].filter((id) => !sortDays.has(id))
    for (const [id, day] of this.visibleSortDays(missing)) sortDays.set(id, day)
    const semanticCandidates: ChunkCandidate[] = scored
      .filter((c) => sortDays.has(c.sessionId))
      .map((c) => ({
        chunkId: c.chunkId,
        sessionId: c.sessionId,
        field: c.field,
        ord: c.ord,
        paraFrom: c.paraFrom,
        paraTo: c.paraTo,
        semantic: { cosine: c.cosine }
      }))
    const ranked = rankDocuments(
      [...exact.candidates, ...semanticCandidates],
      (id) => sortDays.get(id) ?? ''
    )
    const allowed =
      input.scope.kind === 'dossier' ? this.sessionsOfDossier(input.scope.dossierId) : null
    const { documents, truncated } = filterAndLimit(ranked, allowed, SEARCH_MAX_DOCUMENT_RESULTS)
    return {
      requestId: input.requestId,
      dossiers: input.scope.kind === 'all' ? this.findDossiers(input.query) : [],
      results: this.buildResults(documents, terms),
      truncated: truncated || exact.capped,
      semantic: 'complete'
    }
  }

  /** Tag im Verlauf der sichtbaren unter den Sitzungen. */
  private visibleSortDays(ids: string[]): Map<string, string> {
    const map = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const rows = this.db
        .prepare(
          `SELECT s.id, ${SEARCH_SORT_DAY} AS sort_day FROM sessions s
           WHERE ${SEARCH_VISIBLE_SESSION} AND s.id IN (${part.map(() => '?').join(',')})`
        )
        .all(...part) as Array<{ id: string; sort_day: string }>
      for (const row of rows) map.set(row.id, row.sort_day)
    }
    return map
  }

  /** Sitzungen, die dem Patientendossier JETZT zugeordnet sind (#211 AK 1). */
  private sessionsOfDossier(dossierId: string): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT session_id FROM session_dossiers WHERE dossier_id = ?')
        .pluck()
        .all(dossierId) as string[]
    )
  }

  /**
   * Patientendossiers (#209 AK 23–25): jedes Wort der Anfrage ist Teil des
   * Vor- oder Nachnamens, oder die ganze Anfrage ist Teil der
   * Patientendossier-ID. Sortiert wie die Übersicht, höchstens
   * SEARCH_MAX_DOSSIER_RESULTS. ID und Geburtsdatum gehen mit, damit
   * gleichnamige Dossiers unterscheidbar sind.
   */
  findDossiers(query: string): SearchDossierResult[] {
    const words = queryWords(query)
    const whole = normalizeSearchText(query).trim()
    if (words.length === 0 && whole.length === 0) return []
    const nameClause =
      words.length > 0
        ? words
            .map(() => '(instr(d.first_name_norm, ?) > 0 OR instr(d.last_name_norm, ?) > 0)')
            .join(' AND ')
        : '0'
    const params: string[] = words.flatMap((w) => [w, w])
    params.push(whole)
    const rows = this.db
      .prepare(
        `SELECT d.id, d.first_name, d.last_name, d.external_id, d.birth_date
         FROM dossiers d
         WHERE (${nameClause})
            OR (? <> '' AND instr(COALESCE(d.external_id_norm, ''), ?) > 0)
         ORDER BY d.last_name_norm, d.first_name_norm, d.id
         LIMIT ?`
      )
      .all(...params, whole, SEARCH_MAX_DOSSIER_RESULTS) as DossierRow[]
    return rows.map(rowToRef)
  }

  /** Ausschnitte, Fundstellen, Titel, Datum und Dossiers der getroffenen Dokumente. */
  private buildResults(documents: RankedDocument[], terms: string[]): SearchDocumentResult[] {
    if (documents.length === 0) return []
    const chunkIds = documents.flatMap((d) => d.hits.map((h) => h.primary.chunkId))
    const chunks = new Map<number, StoredChunk>(
      this.index.findChunksByIds(chunkIds).map((c) => [c.id, c])
    )
    const ids = documents.map((d) => d.sessionId)
    const textGens = this.index.findTextGens(ids)
    const meta = this.sessionMeta(ids)
    const dossiers = this.dossiersOfSessions(ids)

    const results: SearchDocumentResult[] = []
    for (const doc of documents) {
      const session = meta.get(doc.sessionId)
      if (!session) continue
      const hits = doc.hits
        .map((hit) => {
          const built = buildHit(hit, chunks, terms)
          const gen = chunks.get(hit.primary.chunkId)?.gen
          const current = textGens.get(doc.sessionId)
          if (built && gen !== undefined && current !== undefined && gen !== current) {
            built.fromEarlierVersion = true
          }
          return built
        })
        .filter((h): h is NonNullable<typeof h> => h !== null)
      results.push({
        sessionId: doc.sessionId,
        type: session.type,
        title: session.title,
        titlePlain: session.title_plain ?? session.title,
        sortDay: doc.sortDay,
        dossiers: dossiers.get(doc.sessionId) ?? [],
        hits
      })
    }
    return results
  }

  private sessionMeta(ids: string[]): Map<string, SessionMetaRow> {
    const map = new Map<string, SessionMetaRow>()
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const rows = this.db
        .prepare(
          `SELECT id, type, title, title_plain FROM sessions
           WHERE deleting_at IS NULL AND id IN (${part.map(() => '?').join(',')})`
        )
        .all(...part) as SessionMetaRow[]
      for (const row of rows) map.set(row.id, row)
    }
    return map
  }

  private dossiersOfSessions(ids: string[]): Map<string, DossierRef[]> {
    const map = new Map<string, DossierRef[]>()
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      const rows = this.db
        .prepare(
          `SELECT sd.session_id, d.id, d.first_name, d.last_name, d.external_id, d.birth_date
           FROM session_dossiers sd JOIN dossiers d ON d.id = sd.dossier_id
           WHERE sd.session_id IN (${part.map(() => '?').join(',')})
           ORDER BY d.last_name_norm, d.first_name_norm, d.id`
        )
        .all(...part) as Array<DossierRow & { session_id: string }>
      for (const row of rows) {
        const list = map.get(row.session_id)
        if (list) list.push(rowToRef(row))
        else map.set(row.session_id, [rowToRef(row)])
      }
    }
    return map
  }

  listRecent(): RecentSearchQuery[] {
    return this.recent.list()
  }

  rememberRecent(query: string): void {
    this.recent.remember(query)
  }

  clearRecent(): void {
    this.recent.clear()
  }
}
