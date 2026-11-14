import type Database from 'better-sqlite3'

/** Höchstzahl «Zuletzt geöffnet» (#213 AK 1). */
export const RECENT_LIMIT = 8

export type RecentTarget = { kind: 'dossier'; id: string } | { kind: 'session'; id: string }

export interface RecentRow {
  dossierId: string | null
  sessionId: string | null
  openedAt: string
}

/**
 * «Zuletzt geöffnet» (#213), Tabelle `recent_items` (Migration 020). Jede
 * Zeile verweist auf genau ein Dossier oder eine Sitzung, beide mit
 * `ON DELETE CASCADE`: das Löschen eines Dossiers bzw. die letzte Phase des
 * Löschens einer Sitzung nimmt den Eintrag mit (PC 2). Sitzungen im Löschen
 * (`deleting_at`) liest `list` nie.
 */
export class RecentRepository {
  constructor(private db: Database.Database) {}

  /**
   * Setzt den Eintrag an die Spitze (neu oder aktualisiert) und behält
   * höchstens RECENT_LIMIT. Zeitstempel streng steigend, auch bei zwei
   * Aufrufen in derselben Millisekunde — sonst wäre die Reihenfolge offen.
   */
  touch(target: RecentTarget, now: Date = new Date()): void {
    this.db.transaction(() => {
      const latest = (
        this.db.prepare('SELECT MAX(opened_at) AS t FROM recent_items').get() as {
          t: string | null
        }
      ).t
      let openedAt = now.toISOString()
      if (latest !== null && openedAt <= latest) {
        openedAt = new Date(new Date(latest).getTime() + 1).toISOString()
      }
      if (target.kind === 'dossier') {
        this.db
          .prepare(
            `INSERT INTO recent_items (dossier_id, opened_at) VALUES (?, ?)
             ON CONFLICT(dossier_id) WHERE dossier_id IS NOT NULL
             DO UPDATE SET opened_at = excluded.opened_at`
          )
          .run(target.id, openedAt)
      } else {
        this.db
          .prepare(
            `INSERT INTO recent_items (session_id, opened_at) VALUES (?, ?)
             ON CONFLICT(session_id) WHERE session_id IS NOT NULL
             DO UPDATE SET opened_at = excluded.opened_at`
          )
          .run(target.id, openedAt)
      }
      this.db
        .prepare(
          `DELETE FROM recent_items WHERE id NOT IN (
             SELECT id FROM recent_items ORDER BY opened_at DESC, id DESC LIMIT ?)`
        )
        .run(RECENT_LIMIT)
    })()
  }

  /** Die jüngsten Einträge, ohne Sitzungen im Löschen; jüngster zuerst. */
  list(limit: number = RECENT_LIMIT): RecentRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.dossier_id, r.session_id, r.opened_at
         FROM recent_items r
         LEFT JOIN sessions s ON s.id = r.session_id
         WHERE r.dossier_id IS NOT NULL OR (s.id IS NOT NULL AND s.deleting_at IS NULL)
         ORDER BY r.opened_at DESC, r.id DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      dossier_id: string | null
      session_id: string | null
      opened_at: string
    }>
    return rows.map((r) => ({
      dossierId: r.dossier_id,
      sessionId: r.session_id,
      openedAt: r.opened_at
    }))
  }
}
