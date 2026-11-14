import type Database from 'better-sqlite3'
import { normalizeSearchText } from '../../shared/utils/search-normalize'
import {
  SEARCH_MAX_CANDIDATE_CHUNKS,
  SEARCH_MIN_TERM_LENGTH,
  SEARCH_SHORT_QUERY_MAX_CHUNKS,
  SEARCH_SHORT_QUERY_MAX_SESSIONS
} from '../../shared/search-config'
import { SEARCH_SORT_DAY, SEARCH_VISIBLE_SESSION } from '../db/repositories/SearchIndexRepository'
import type { ChunkCandidate } from './ranking'
import type { SearchField } from '../../shared/types/Search'

/**
 * Exakte Suche (#209 AK 3–5; Entscheid des Orchestrators): jedes Wort der
 * Anfrage mit mindestens SEARCH_MIN_TERM_LENGTH Zeichen kommt als Teilwort im
 * selben Abschnitt vor — unabhängig von Gross-/Kleinschreibung und der
 * Schreibweise von Umlauten. Der Trigramm-Index (search_fts) findet solche
 * Teilwörter als Phrase; kürzere Wörter sind dann nur Füllwerk.
 *
 * Besteht die Anfrage nur aus kürzeren Wörtern, liefert der Trigramm-Index
 * nichts; dann durchsucht ein Scan den gespeicherten normalisierten Text
 * (neueste Sitzungen zuerst) und hört nach SEARCH_SHORT_QUERY_MAX_CHUNKS
 * Treffer-Abschnitten auf.
 *
 * Gesucht wird über den Klartext von Text, Titel und Zusammenfassung (AK 4,
 * AK 5), nur in fertig verarbeiteten Sitzungen, die nicht im Löschen sind.
 */

export interface ParsedQuery {
  /** Normalisierte Wörter, nach denen markiert wird. */
  terms: string[]
  /** 'fts': Trigramm-Phrasen; 'scan': nur kurze Wörter; 'none': nichts Suchbares. */
  mode: 'fts' | 'scan' | 'none'
}

/** Satz- und Sonderzeichen am Wortrand zählen nicht («Angst,» = «Angst»). */
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu

/** Normalisierte Wörter einer Anfrage, ohne Satzzeichen am Rand, dedupliziert. */
export function queryWords(query: string): string[] {
  const words = normalizeSearchText(query)
    .split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCTUATION, ''))
    .filter((w) => w.length > 0)
  return [...new Set(words)]
}

/** Länge in Zeichen (Codepoints), wie der Trigramm-Tokenizer zählt. */
function charLength(word: string): number {
  return [...word].length
}

export function parseQuery(query: string): ParsedQuery {
  const words = queryWords(query)
  const long = words.filter((w) => charLength(w) >= SEARCH_MIN_TERM_LENGTH)
  if (long.length > 0) return { terms: long, mode: 'fts' }
  if (words.length > 0) return { terms: words, mode: 'scan' }
  return { terms: [], mode: 'none' }
}

/** FTS5-Ausdruck: jedes Wort als Phrase (Teilwort-Treffer über Trigramme). */
export function ftsExpression(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ')
}

interface CandidateRow {
  id: number
  session_id: string
  field: SearchField
  ord: number
  para_from: number | null
  para_to: number | null
  score: number
  sort_day: string
}

function rowToCandidate(row: CandidateRow): ChunkCandidate {
  return {
    chunkId: row.id,
    sessionId: row.session_id,
    field: row.field,
    ord: row.ord,
    paraFrom: row.para_from,
    paraTo: row.para_to,
    exact: { bm25: row.score }
  }
}

export interface ExactSearchResult {
  candidates: ChunkCandidate[]
  /** Tag im Verlauf je getroffener Sitzung (für das Ranking). */
  sortDays: Map<string, string>
  /** Eine Obergrenze hat gegriffen — es gibt womöglich weitere Treffer. */
  capped: boolean
}

export interface ExactSearchOptions {
  /** Nur Sitzungen dieses Dossiers (#211) — der Filter greift VOR den Grenzen. */
  dossierId?: string
  /** Höchstens so viele Treffer-Abschnitte (Default SEARCH_MAX_CANDIDATE_CHUNKS). */
  maxCandidates?: number
}

/** Treffer-Abschnitte der exakten Suche aus der aktiven Textgeneration. */
export function findExactCandidates(
  db: Database.Database,
  parsed: ParsedQuery,
  options: ExactSearchOptions = {}
): ExactSearchResult {
  if (parsed.mode === 'fts') return findViaFts(db, parsed.terms, options)
  if (parsed.mode === 'scan') return findViaScan(db, parsed.terms, options)
  return { candidates: [], sortDays: new Map(), capped: false }
}

function collect(rows: CandidateRow[], capped: boolean): ExactSearchResult {
  const sortDays = new Map<string, string>()
  for (const row of rows) sortDays.set(row.session_id, row.sort_day)
  return { candidates: rows.map(rowToCandidate), sortDays, capped }
}

/** Abschnitts-Metadaten der aktiven Generation sichtbarer Sitzungen, per ID. */
function chunkRows(db: Database.Database, scored: Array<[number, number]>): CandidateRow[] {
  if (scored.length === 0) return []
  const score = new Map(scored)
  const rows = db
    .prepare(
      `SELECT c.id, c.session_id, c.field, c.ord, c.para_from, c.para_to, 0 AS score,
              ${SEARCH_SORT_DAY} AS sort_day
       FROM search_chunks c
       JOIN search_index_state st ON st.session_id = c.session_id AND st.text_gen = c.gen
       JOIN sessions s ON s.id = c.session_id
       WHERE c.id IN (SELECT value FROM json_each(?)) AND ${SEARCH_VISIBLE_SESSION}`
    )
    .all(JSON.stringify(scored.map(([id]) => id))) as CandidateRow[]
  for (const row of rows) row.score = score.get(row.id) ?? 0
  return rows
}

/**
 * Trigramm-Phrasen. Über alle Inhalte: die besten `maxCandidates` Abschnitte
 * nach bm25 direkt in FTS5 (`ORDER BY bm25 LIMIT`; gemessen schneller als `ORDER BY rank`), erst danach Join und
 * Gruppierung — der Join über alle Treffer kostete bei «und» (77'000
 * Abschnitte) eine halbe Sekunde. In einem Dossier: alle Treffer mit Rang,
 * gefiltert auf die Abschnitte des Dossiers, DANN begrenzt — sonst fehlten
 * Treffer des Dossiers, die global nicht unter den besten wären (#211 AK 3).
 *
 * Abschnitte veralteter Generationen bzw. gelöschter Sitzungen, die noch auf
 * ihr Aufräumen warten, zählen in der globalen Grenze mit und fallen erst im
 * Join weg — die Grenze ist deshalb eine Obergrenze, kein genaues Mass.
 */
function findViaFts(
  db: Database.Database,
  terms: string[],
  options: ExactSearchOptions
): ExactSearchResult {
  const max = options.maxCandidates ?? SEARCH_MAX_CANDIDATE_CHUNKS
  const expression = ftsExpression(terms)
  let scored: Array<[number, number]>
  if (options.dossierId === undefined) {
    scored = db
      .prepare('SELECT rowid, rank FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?')
      .raw(true)
      .all(expression, max + 1) as Array<[number, number]>
  } else {
    const allowed = new Set(
      db
        .prepare(
          `SELECT c.id FROM session_dossiers sd
           JOIN sessions s ON s.id = sd.session_id
           JOIN search_index_state st ON st.session_id = sd.session_id
           JOIN search_chunks c ON c.session_id = sd.session_id AND c.gen = st.text_gen
           WHERE sd.dossier_id = ? AND ${SEARCH_VISIBLE_SESSION}`
        )
        .pluck()
        .all(options.dossierId) as number[]
    )
    scored =
      allowed.size === 0
        ? []
        : (
            db
              .prepare('SELECT rowid, bm25(search_fts) FROM search_fts WHERE search_fts MATCH ?')
              .raw(true)
              .all(expression) as Array<[number, number]>
          )
            .filter(([id]) => allowed.has(id))
            .sort((a, b) => a[1] - b[1] || a[0] - b[0])
            .slice(0, max + 1)
  }
  const capped = scored.length > max
  return collect(chunkRows(db, capped ? scored.slice(0, max) : scored), capped)
}

/**
 * Kurze Anfragen: Scan über den normalisierten Text, den search_fts selbst
 * speichert (ohne «Sprecher N:»-Präfixe), per instr in SQLite. Durchsucht
 * werden die neuesten SEARCH_SHORT_QUERY_MAX_SESSIONS Sitzungen — in einem
 * Dossier die des Dossiers, der Filter greift vor der Grenze —, höchstens
 * SEARCH_SHORT_QUERY_MAX_CHUNKS Treffer-Abschnitte.
 */
function findViaScan(
  db: Database.Database,
  terms: string[],
  options: ExactSearchOptions
): ExactSearchResult {
  const dossierJoin =
    options.dossierId === undefined
      ? ''
      : 'JOIN session_dossiers sd ON sd.session_id = s.id AND sd.dossier_id = ?'
  const scopeParams = options.dossierId === undefined ? [] : [options.dossierId]
  const where = terms.map(() => 'instr(f.norm, ?) > 0').join(' AND ')
  // Nur IDs über den abdeckenden Index — die Abschnittszeilen (mit Text)
  // liest erst chunkRows für die höchstens 500 Treffer. CROSS JOIN hält die
  // Reihenfolge fest: sonst scannt der Planer den ganzen FTS-Inhalt.
  const ids = db
    .prepare(
      `WITH recent AS MATERIALIZED (
         SELECT s.id FROM sessions s ${dossierJoin}
         WHERE ${SEARCH_VISIBLE_SESSION}
         ORDER BY s.created_at DESC, s.id LIMIT ?
       )
       SELECT c.id
       FROM recent r
       CROSS JOIN search_index_state st ON st.session_id = r.id
       CROSS JOIN search_chunks c ON c.session_id = r.id AND c.gen = st.text_gen
       CROSS JOIN search_fts f ON f.rowid = c.id
       WHERE ${where}
       LIMIT ?`
    )
    .pluck()
    .all(
      ...scopeParams,
      SEARCH_SHORT_QUERY_MAX_SESSIONS,
      ...terms,
      SEARCH_SHORT_QUERY_MAX_CHUNKS + 1
    ) as number[]
  const rows = chunkRows(
    db,
    ids.slice(0, SEARCH_SHORT_QUERY_MAX_CHUNKS).map((id): [number, number] => [id, 0])
  )
  let capped = ids.length > SEARCH_SHORT_QUERY_MAX_CHUNKS
  if (!capped) {
    const visible = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sessions s ${dossierJoin} WHERE ${SEARCH_VISIBLE_SESSION}`
        )
        .get(...scopeParams) as { n: number }
    ).n
    capped = visible > SEARCH_SHORT_QUERY_MAX_SESSIONS
  }
  return collect(rows, capped)
}
