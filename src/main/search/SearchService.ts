import type Database from 'better-sqlite3'
import { SearchIndexRepository, type StoredChunk } from '../db/repositories/SearchIndexRepository'
import { SearchRecentRepository } from '../db/repositories/SearchRecentRepository'
import { findExactCandidates, parseQuery, queryWords } from './exactSearch'
import { filterAndLimit, rankDocuments, type RankedDocument } from './ranking'
import { buildHit } from './snippet'
import { normalizeSearchText } from '../../shared/utils/search-normalize'
import { SEARCH_MAX_DOCUMENT_RESULTS, SEARCH_MAX_DOSSIER_RESULTS } from '../../shared/search-config'
import type { DossierRef } from '../../shared/types/Dossier'
import type { SessionType } from '../../shared/types'
import type {
  RecentSearchQuery,
  SearchDocumentResult,
  SearchDossierResult,
  SearchQueryInput,
  SearchQueryResult,
  SearchScope,
  SemanticSearchStatus
} from '../../shared/types/Search'

/**
 * Suche im Main-Prozess (Epic #192 — #209, #211): Patientendossiers und
 * exakte Treffer in einer synchronen Antwort. PR S4 ergänzt die Suche nach
 * Bedeutung über `search:semantic` und ersetzt den Grundwert von `semantic`.
 */

export interface SearchServiceDeps {
  /** Stand der Suche nach Bedeutung; bis PR S4 immer 'unavailable'. */
  semanticStatus?: () => SemanticSearchStatus
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
  private semanticStatus: () => SemanticSearchStatus

  constructor(
    private db: Database.Database,
    deps: SearchServiceDeps = {}
  ) {
    this.index = new SearchIndexRepository(db)
    this.recent = new SearchRecentRepository(db)
    this.semanticStatus = deps.semanticStatus ?? ((): SemanticSearchStatus => 'unavailable')
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
   * Exakte Treffer, gerankt und erst DANACH auf das Dossier gefiltert und
   * geschnitten (#211 AK 3). Öffentlich für PR S4 (Mischung mit Treffern nach
   * Bedeutung) und den Abnahmetest.
   */
  rankExact(
    query: string,
    scope: SearchScope
  ): { documents: RankedDocument[]; truncated: boolean; terms: string[] } {
    const parsed = parseQuery(query)
    const exact = findExactCandidates(this.db, parsed)
    const ranked = rankDocuments(exact.candidates, (id) => exact.sortDays.get(id) ?? '')
    const allowed = scope.kind === 'dossier' ? this.sessionsOfDossier(scope.dossierId) : null
    const { documents, truncated } = filterAndLimit(ranked, allowed, SEARCH_MAX_DOCUMENT_RESULTS)
    return { documents, truncated: truncated || exact.capped, terms: parsed.terms }
  }

  /** Sitzungen, die dem Dossier JETZT zugeordnet sind (#211 AK 1). */
  private sessionsOfDossier(dossierId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT session_id FROM session_dossiers WHERE dossier_id = ?')
      .all(dossierId) as Array<{ session_id: string }>
    return new Set(rows.map((r) => r.session_id))
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
    const chunkIds = documents.flatMap((d) => d.hits.flatMap((h) => h.merged.map((m) => m.chunkId)))
    const chunks = new Map<number, StoredChunk>(
      this.index.findChunksByIds(chunkIds).map((c) => [c.id, c])
    )
    const ids = documents.map((d) => d.sessionId)
    const meta = this.sessionMeta(ids)
    const dossiers = this.dossiersOfSessions(ids)

    const results: SearchDocumentResult[] = []
    for (const doc of documents) {
      const session = meta.get(doc.sessionId)
      if (!session) continue
      const hits = doc.hits
        .map((hit) => buildHit(hit, chunks, terms))
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
