import type Database from 'better-sqlite3'
import type { SessionType } from '../../../shared/types'
import type { SearchField } from '../../../shared/types/Search'
import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import { sectionIndexText, type ChunkUnitRef, type SearchSection } from '../../search/chunker'

/**
 * Suchindex (Migration 021, Epic #192 — #209, #210, #212). Schreibt und liest
 * search_index_state, search_chunks und search_fts. Nur der Klartext steht im
 * Index; Löschen hängt an sessions(id) ON DELETE CASCADE plus Trigger.
 */

/**
 * Sichtbar für die Suche: fertig verarbeitet (review) und nicht im Löschen.
 * Jede Leseabfrage der Suche filtert damit, deshalb ist eine markierte
 * Sitzung sofort unauffindbar — auch wenn Phase 2 des Löschens noch aussteht
 * (#209 PC 1, #212 PC 1). Alias `s` für sessions.
 */
export const SEARCH_VISIBLE_SESSION = `s.status = 'review' AND s.deleting_at IS NULL`

/** Tag im Verlauf, wie Dossier-Übersicht und Verlauf ihn rechnen (#205). */
export const SEARCH_SORT_DAY = `CASE WHEN s.type = 'pdf'
  THEN COALESCE(s.document_date, date(s.created_at, 'localtime'))
  ELSE date(s.created_at, 'localtime') END`

export interface PendingTextSession {
  id: string
  type: SessionType
  title: string
  titlePlain: string
  summary: string | null
  summaryPlain: string | null
  anonymizedPath: string | null
  searchRev: number
}

interface PendingRow {
  id: string
  type: SessionType
  title: string
  title_plain: string | null
  summary: string | null
  summary_plain: string | null
  anonymized_path: string | null
  search_rev: number
}

export interface StoredChunk {
  id: number
  sessionId: string
  field: SearchField
  ord: number
  paraFrom: number | null
  paraTo: number | null
  units: ChunkUnitRef[]
  text: string
}

interface ChunkRow {
  id: number
  session_id: string
  field: SearchField
  ord: number
  para_from: number | null
  para_to: number | null
  units: string
  text: string
}

function parseUnits(json: string): ChunkUnitRef[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? (value as ChunkUnitRef[]) : []
  } catch {
    return []
  }
}

export function rowToChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    field: row.field,
    ord: row.ord,
    paraFrom: row.para_from,
    paraTo: row.para_to,
    units: parseUnits(row.units),
    text: row.text
  }
}

export class SearchIndexRepository {
  constructor(private db: Database.Database) {}

  /**
   * Sitzungen, deren Textgeneration fehlt oder veraltet ist (#212): fertig
   * verarbeitet, nicht im Löschen, letzte Änderung vor `quietBefore` (ruhiges
   * Fenster, #212 OOS 1). Der Bestand vor dem Update hat noch keine Zeile in
   * search_index_state und fällt unter dieselbe Regel (#210 AK 1). Geänderte
   * und neu verarbeitete Sitzungen (search_rev > 0) vor dem Bestand, jeweils
   * die neuesten zuerst.
   */
  findPendingText(quietBefore: string, limit: number): PendingTextSession[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.type, s.title, s.title_plain, s.summary, s.summary_plain,
                s.anonymized_path, s.search_rev
         FROM sessions s
         LEFT JOIN search_index_state st ON st.session_id = s.id
         WHERE ${SEARCH_VISIBLE_SESSION}
           AND (st.session_id IS NULL OR st.text_rev < s.search_rev)
           AND s.updated_at <= ?
         ORDER BY (s.search_rev > 0) DESC, s.updated_at DESC, s.id
         LIMIT ?`
      )
      .all(quietBefore, limit) as PendingRow[]
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      titlePlain: row.title_plain ?? row.title,
      summary: row.summary,
      summaryPlain: row.summary == null ? null : (row.summary_plain ?? row.summary),
      anonymizedPath: row.anonymized_path,
      searchRev: row.search_rev
    }))
  }

  /** true, solange mindestens eine Sitzung ausserhalb des ruhigen Fensters auf ihre Textphase wartet. */
  hasPendingText(quietBefore: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sessions s
           LEFT JOIN search_index_state st ON st.session_id = s.id
           WHERE ${SEARCH_VISIBLE_SESSION}
             AND (st.session_id IS NULL OR st.text_rev < s.search_rev)
             AND s.updated_at <= ?
           LIMIT 1`
        )
        .get(quietBefore) !== undefined
    )
  }

  /**
   * Schreibt eine neue Textgeneration samt FTS-Einträgen und macht sie aktiv —
   * in EINER Transaktion: die exakte Suche sieht entweder den alten oder den
   * neuen Stand, nie einen halben (#212 AK 1). Ältere Generationen löscht
   * diese Methode NICHT: Löschen im FTS-Index mit 'secure-delete' kostet
   * ~40 ms pro Abschnitt, eine 2-Stunden-Sitzung blockierte sonst Sekunden.
   * Über den Join auf `text_gen` sind sie sofort unsichtbar; die
   * Hintergrundschleife entfernt sie abschnittweise (`findStaleChunk`).
   *
   * Gibt die neue Generation zurück, oder null (und schreibt nichts), wenn die
   * Sitzung inzwischen gelöscht, markiert oder nicht mehr fertig verarbeitet
   * ist, oder wenn ihr Inhalt seit dem Lesen erneut geändert wurde — dann holt
   * der nächste Takt sie mit dem neuen Stand.
   */
  writeTextGeneration(
    sessionId: string,
    readRev: number,
    sections: SearchSection[],
    error: string | null,
    docStat: string | null = null
  ): number | null {
    return this.db.transaction((): number | null => {
      const current = this.db
        .prepare(`SELECT s.search_rev FROM sessions s WHERE s.id = ? AND ${SEARCH_VISIBLE_SESSION}`)
        .get(sessionId) as { search_rev: number } | undefined
      if (!current || current.search_rev !== readRev) return null

      const state = this.db
        .prepare('SELECT vec_gen FROM search_index_state WHERE session_id = ?')
        .get(sessionId) as { vec_gen: number | null } | undefined
      const maxGen = (
        this.db
          .prepare('SELECT MAX(gen) AS g FROM search_chunks WHERE session_id = ?')
          .get(sessionId) as { g: number | null }
      ).g
      const gen = Math.max(maxGen ?? 0, state?.vec_gen ?? 0) + 1

      const insertChunk = this.db.prepare(
        `INSERT INTO search_chunks (session_id, gen, field, ord, para_from, para_to, units, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertFts = this.db.prepare('INSERT INTO search_fts (rowid, norm) VALUES (?, ?)')
      for (const section of sections) {
        const { lastInsertRowid } = insertChunk.run(
          sessionId,
          gen,
          section.field,
          section.ord,
          section.paraFrom,
          section.paraTo,
          JSON.stringify(section.units),
          section.text
        )
        insertFts.run(lastInsertRowid, normalizeSearchText(sectionIndexText(section)))
      }

      this.db
        .prepare(
          `INSERT INTO search_index_state (session_id, text_gen, text_rev, last_error, doc_stat)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             text_gen = excluded.text_gen,
             text_rev = excluded.text_rev,
             last_error = excluded.last_error,
             doc_stat = excluded.doc_stat`
        )
        .run(sessionId, gen, readRev, error, docStat)
      return gen
    })()
  }

  /**
   * Ein Abschnitt einer veralteten Generation der Sitzung (weder `text_gen`
   * noch `vec_gen`; ohne Zustandszeile jeder), oder null. Über den Index
   * (session_id, gen).
   */
  findStaleChunk(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT c.id FROM search_chunks c
         LEFT JOIN search_index_state st ON st.session_id = c.session_id
         WHERE c.session_id = ?
           AND (st.session_id IS NULL OR (c.gen <> st.text_gen AND c.gen IS NOT st.vec_gen))
         LIMIT 1`
      )
      .get(sessionId) as { id: number } | undefined
    return row?.id ?? null
  }

  /**
   * Sitzungen mit veralteten Generationen oder mit Abschnitten ohne Zustand —
   * einmal beim Start (Aufräumen überlebt einen Neustart). Ein Durchgang über
   * search_chunks, danach arbeitet die Schleife pro Sitzung über den Index.
   */
  findSessionsWithStaleChunks(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT c.session_id FROM search_chunks c
           LEFT JOIN search_index_state st ON st.session_id = c.session_id
           WHERE st.session_id IS NULL OR (c.gen <> st.text_gen AND c.gen IS NOT st.vec_gen)`
        )
        .all() as Array<{ session_id: string }>
    ).map((r) => r.session_id)
  }

  /** Markierte Sitzungen (deleting_at), die noch Indexzeilen haben — Start der Schleife. */
  findMarkedSessionsWithChunks(): string[] {
    return (
      this.db
        .prepare(
          `SELECT s.id FROM sessions s
           WHERE s.deleting_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM search_chunks c WHERE c.session_id = s.id)`
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id)
  }

  /** Irgendein Abschnitt der Sitzung (alle Generationen), oder null. */
  findAnyChunk(sessionId: string): number | null {
    const row = this.db
      .prepare('SELECT id FROM search_chunks WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { id: number } | undefined
    return row?.id ?? null
  }

  hasChunks(sessionId: string): boolean {
    return this.findAnyChunk(sessionId) !== null
  }

  /** Löscht einen Abschnitt; der Trigger entfernt seinen FTS-Eintrag. */
  deleteChunk(id: number): void {
    this.db.prepare('DELETE FROM search_chunks WHERE id = ?').run(id)
  }

  /** Zustand einer Sitzung ohne Abschnitte entfernen (Löschpfad mit Dateirest). */
  deleteState(sessionId: string): void {
    this.db.prepare('DELETE FROM search_index_state WHERE session_id = ?').run(sessionId)
  }

  /**
   * Fertig indexierte Sitzungen mit Dokumentpfad und dem beim Indexieren
   * gemerkten Dateistand — für die Prüfung beim Start (ReviewService.save
   * schreibt erst die Datei, dann die DB; ein Absturz dazwischen hinterliesse
   * sonst einen veralteten Index).
   */
  findIndexedDocStats(): Array<{ id: string; path: string; docStat: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT s.id, s.anonymized_path AS path, st.doc_stat
           FROM sessions s JOIN search_index_state st ON st.session_id = s.id
           WHERE ${SEARCH_VISIBLE_SESSION} AND s.anonymized_path IS NOT NULL
             AND st.text_rev = s.search_rev`
        )
        .all() as Array<{ id: string; path: string; doc_stat: string | null }>
    ).map((r) => ({ id: r.id, path: r.path, docStat: r.doc_stat }))
  }

  /** Sitzung wieder «zu bearbeiten» machen, ohne `updated_at` zu ändern. */
  markTextStale(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET search_rev = search_rev + 1 WHERE id = ?').run(sessionId)
  }

  /** Abschnitte per ID (für Ausschnitte der gewählten Fundstellen). */
  findChunksByIds(ids: number[]): StoredChunk[] {
    if (ids.length === 0) return []
    const rows: ChunkRow[] = []
    // SQLite-Grenze für gebundene Parameter respektieren
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      rows.push(
        ...(this.db
          .prepare(
            `SELECT id, session_id, field, ord, para_from, para_to, units, text
             FROM search_chunks WHERE id IN (${part.map(() => '?').join(',')})`
          )
          .all(...part) as ChunkRow[])
      )
    }
    return rows.map(rowToChunk)
  }

  /** Aktive Textgeneration einer Sitzung (Tests, Diagnose). */
  findActiveChunks(sessionId: string): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.session_id, c.field, c.ord, c.para_from, c.para_to, c.units, c.text
         FROM search_chunks c
         JOIN search_index_state st ON st.session_id = c.session_id AND st.text_gen = c.gen
         WHERE c.session_id = ?
         ORDER BY CASE c.field WHEN 'title' THEN 0 WHEN 'summary' THEN 1 ELSE 2 END, c.ord`
      )
      .all(sessionId) as ChunkRow[]
    return rows.map(rowToChunk)
  }
}
