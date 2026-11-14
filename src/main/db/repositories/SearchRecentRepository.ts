import type Database from 'better-sqlite3'
import type { RecentSearchQuery } from '../../../shared/types/Search'
import { SEARCH_MAX_QUERY_LENGTH, SEARCH_RECENT_LIMIT } from '../../../shared/search-config'
import { normalizeSearchText } from '../../../shared/utils/search-normalize'
import { walCheckpointTruncate } from '../maintenance'

/**
 * Die fünf letzten Suchanfragen (#209 AK 27/28, PC 2–4), Tabelle
 * search_recent_queries (Migration 021). Nur die Suche über alle Inhalte
 * speist sie (#211 OOS 3) — der Renderer ruft `remember` nur dort auf.
 *
 * Löschen wirkt mit PRAGMA secure_delete (Verbindung) und einem
 * WAL-Checkpoint: danach steht die Anfrage weder in .db noch in -wal.
 */

/** Dedup-Schlüssel: normalisiert, Leerraum zusammengefasst. */
export function recentQueryKey(query: string): string {
  return normalizeSearchText(query).trim().split(/\s+/).join(' ')
}

export class SearchRecentRepository {
  constructor(private db: Database.Database) {}

  list(): RecentSearchQuery[] {
    const rows = this.db
      .prepare(
        `SELECT query, used_at FROM search_recent_queries
         ORDER BY used_at DESC, id DESC LIMIT ?`
      )
      .all(SEARCH_RECENT_LIMIT) as Array<{ query: string; used_at: string }>
    return rows.map((row) => ({ query: row.query, usedAt: row.used_at }))
  }

  /**
   * Merkt eine Anfrage (an die Spitze, dedupliziert über den normalisierten
   * Schlüssel) und behält höchstens SEARCH_RECENT_LIMIT. Leere Anfragen
   * werden ignoriert.
   */
  remember(query: string, now: Date = new Date()): void {
    const text = query.trim().slice(0, SEARCH_MAX_QUERY_LENGTH)
    const key = recentQueryKey(text)
    if (text.length === 0 || key.length === 0) return
    this.db.transaction(() => {
      // Streng steigend, auch bei zwei Anfragen in derselben Millisekunde
      const latest = (
        this.db.prepare('SELECT MAX(used_at) AS t FROM search_recent_queries').get() as {
          t: string | null
        }
      ).t
      let usedAt = now.toISOString()
      if (latest !== null && usedAt <= latest) {
        usedAt = new Date(new Date(latest).getTime() + 1).toISOString()
      }
      this.db
        .prepare(
          `INSERT INTO search_recent_queries (query, query_norm, used_at) VALUES (?, ?, ?)
           ON CONFLICT(query_norm) DO UPDATE SET query = excluded.query, used_at = excluded.used_at`
        )
        .run(text, key, usedAt)
      this.db
        .prepare(
          `DELETE FROM search_recent_queries WHERE id NOT IN (
             SELECT id FROM search_recent_queries ORDER BY used_at DESC, id DESC LIMIT ?)`
        )
        .run(SEARCH_RECENT_LIMIT)
    })()
  }

  /** «Verlauf löschen» (#209 AK 28, PC 3): alles weg, danach Checkpoint. */
  clear(): void {
    this.db.prepare('DELETE FROM search_recent_queries').run()
    this.checkpoint()
  }

  /**
   * #209 PC 4: Anfragen entfernen, die einen der Begriffe (Vor-/Nachname,
   * Patientendossier-ID eines gelöschten Dossiers) enthalten. Zu viel zu
   * löschen ist unbedenklich. Kein Checkpoint — der Aufrufer (Löschen eines
   * Dossiers) checkpointet am Ende selbst. Gibt die Anzahl gelöschter Zeilen
   * zurück.
   */
  forgetContaining(terms: Array<string | null | undefined>): number {
    const keys = [
      ...new Set(
        terms
          .filter((t): t is string => typeof t === 'string')
          .map(recentQueryKey)
          .filter((k) => k.length > 0)
      )
    ]
    if (keys.length === 0) return 0
    const where = keys.map(() => 'instr(query_norm, ?) > 0').join(' OR ')
    return this.db.prepare(`DELETE FROM search_recent_queries WHERE ${where}`).run(...keys).changes
  }

  private checkpoint(): void {
    try {
      if (!walCheckpointTruncate(this.db)) {
        console.error(
          '[Search] WAL-Checkpoint nach dem Löschen der letzten Suchanfragen blockiert — wird beim nächsten Löschen bzw. Start nachgeholt'
        )
      }
    } catch (error) {
      console.error('[Search] WAL-Checkpoint fehlgeschlagen:', error)
    }
  }
}
