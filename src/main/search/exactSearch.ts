import type Database from 'better-sqlite3'
import { normalizeSearchText } from '../../shared/utils/search-normalize'
import { SEARCH_MIN_TERM_LENGTH, SEARCH_SHORT_QUERY_MAX_CHUNKS } from '../../shared/search-config'
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
  /** Scan abgebrochen, weil die Obergrenze erreicht war. */
  capped: boolean
}

/** Treffer-Abschnitte der exakten Suche aus der aktiven Textgeneration. */
export function findExactCandidates(db: Database.Database, parsed: ParsedQuery): ExactSearchResult {
  if (parsed.mode === 'fts') return findViaFts(db, parsed.terms)
  if (parsed.mode === 'scan') return findViaScan(db, parsed.terms)
  return { candidates: [], sortDays: new Map(), capped: false }
}

function collect(rows: CandidateRow[], capped: boolean): ExactSearchResult {
  const sortDays = new Map<string, string>()
  for (const row of rows) sortDays.set(row.session_id, row.sort_day)
  return { candidates: rows.map(rowToCandidate), sortDays, capped }
}

function findViaFts(db: Database.Database, terms: string[]): ExactSearchResult {
  const rows = db
    .prepare(
      `WITH m AS MATERIALIZED (
         SELECT rowid AS id, bm25(search_fts) AS score FROM search_fts WHERE search_fts MATCH ?
       )
       SELECT c.id, c.session_id, c.field, c.ord, c.para_from, c.para_to, m.score,
              ${SEARCH_SORT_DAY} AS sort_day
       FROM m
       JOIN search_chunks c ON c.id = m.id
       JOIN search_index_state st ON st.session_id = c.session_id AND st.text_gen = c.gen
       JOIN sessions s ON s.id = c.session_id
       WHERE ${SEARCH_VISIBLE_SESSION}`
    )
    .all(ftsExpression(terms)) as CandidateRow[]
  return collect(rows, false)
}

/**
 * Kurze Anfragen: Scan über den normalisierten Text, den search_fts selbst
 * speichert (ohne «Sprecher N:»-Präfixe), per instr in SQLite. Neueste
 * Sitzungen zuerst, höchstens SEARCH_SHORT_QUERY_MAX_CHUNKS Treffer-Abschnitte.
 */
function findViaScan(db: Database.Database, terms: string[]): ExactSearchResult {
  const where = terms.map(() => 'instr(norm, ?) > 0').join(' AND ')
  const rows = db
    .prepare(
      `WITH m AS MATERIALIZED (SELECT rowid AS id FROM search_fts WHERE ${where})
       SELECT c.id, c.session_id, c.field, c.ord, c.para_from, c.para_to, 0 AS score,
              ${SEARCH_SORT_DAY} AS sort_day
       FROM m
       JOIN search_chunks c ON c.id = m.id
       JOIN search_index_state st ON st.session_id = c.session_id AND st.text_gen = c.gen
       JOIN sessions s ON s.id = c.session_id
       WHERE ${SEARCH_VISIBLE_SESSION}
       ORDER BY sort_day DESC, s.created_at DESC, c.session_id, c.id
       LIMIT ?`
    )
    .all(...terms, SEARCH_SHORT_QUERY_MAX_CHUNKS + 1) as CandidateRow[]
  const capped = rows.length > SEARCH_SHORT_QUERY_MAX_CHUNKS
  return collect(capped ? rows.slice(0, SEARCH_SHORT_QUERY_MAX_CHUNKS) : rows, capped)
}
