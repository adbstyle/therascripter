import type Database from 'better-sqlite3'
import type { DossierRef, TimelineEntry } from '../../../shared/types/Dossier'
import { rowToSession, SESSION_LIST_COLUMNS, type SessionRow } from './SessionRepository'

interface AssignmentRow {
  session_id: string
  id: string
  first_name: string
  last_name: string
  external_id: string | null
  birth_date: string | null
}

type TimelineRow = SessionRow & { sort_day: string }

function rowToRef(row: AssignmentRow): DossierRef {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    externalId: row.external_id,
    birthDate: row.birth_date
  }
}

const REF_COLUMNS = 'd.id, d.first_name, d.last_name, d.external_id, d.birth_date'
/** Dieselbe Namensordnung wie die Dossier-Übersicht (ä wie ae). */
const NAME_ORDER = 'd.last_name_norm, d.first_name_norm, d.id'

/**
 * Tag, der die Stelle eines Eintrags im Verlauf bestimmt (#205 AK 8): bei
 * PDFs das Dokumentdatum, sonst — und bei Sitzungen immer — der lokale Tag
 * des Zeitstempels. `created_at` ist UTC; `localtime` rechnet in der
 * Zeitzone des Macs, inklusive Sommer- und Winterzeit.
 */
const SORT_DAY = `CASE WHEN s.type = 'pdf'
                       THEN COALESCE(s.document_date, date(s.created_at, 'localtime'))
                       ELSE date(s.created_at, 'localtime') END`

/**
 * Zuordnungen von Sitzungen und PDF-Dokumenten zu Patientendossiers (#205).
 *
 * Die Tabelle `session_dossiers` enthält nur IDs und den Zeitpunkt der
 * Zuordnung; beide Fremdschlüssel löschen per ON DELETE CASCADE mit. Jede
 * Abfrage über `sessions` blendet Sitzungen im Löschen (deleting_at) aus.
 */
export class SessionDossierRepository {
  constructor(private db: Database.Database) {}

  /** true, wenn die Zuordnung neu ist; eine bestehende bleibt unverändert. */
  assign(sessionId: string, dossierId: string, assignedAt: string): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO session_dossiers (session_id, dossier_id, assigned_at) VALUES (?, ?, ?)'
      )
      .run(sessionId, dossierId, assignedAt)
    return result.changes > 0
  }

  /** true, wenn eine Zuordnung entfernt wurde. */
  unassign(sessionId: string, dossierId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM session_dossiers WHERE session_id = ? AND dossier_id = ?')
      .run(sessionId, dossierId)
    return result.changes > 0
  }

  /** Dossiers einer Sitzung, alphabetisch. */
  listForSession(sessionId: string): DossierRef[] {
    const rows = this.db
      .prepare(
        `SELECT sd.session_id, ${REF_COLUMNS}
         FROM session_dossiers sd
         JOIN dossiers d ON d.id = sd.dossier_id
         WHERE sd.session_id = ?
         ORDER BY ${NAME_ORDER}`
      )
      .all(sessionId) as AssignmentRow[]
    return rows.map(rowToRef)
  }

  /**
   * Dossiers mehrerer Sitzungen in EINER Abfrage (#205 AK 5): die Sitzungsliste
   * holt so die Plaketten für alle Karten, ohne GROUP_CONCAT zu parsen. Die
   * IDs gehen als ein JSON-Parameter hinein — keine Grenze für die Anzahl der
   * SQL-Parameter. Sitzungen ohne Zuordnung fehlen in der Map.
   */
  listForSessions(sessionIds: readonly string[]): Map<string, DossierRef[]> {
    const result = new Map<string, DossierRef[]>()
    if (sessionIds.length === 0) return result
    const rows = this.db
      .prepare(
        `SELECT sd.session_id, ${REF_COLUMNS}
         FROM session_dossiers sd
         JOIN dossiers d ON d.id = sd.dossier_id
         WHERE sd.session_id IN (SELECT value FROM json_each(?))
         ORDER BY ${NAME_ORDER}`
      )
      .all(JSON.stringify(sessionIds)) as AssignmentRow[]
    for (const row of rows) {
      const list = result.get(row.session_id)
      if (list) list.push(rowToRef(row))
      else result.set(row.session_id, [rowToRef(row)])
    }
    return result
  }

  /**
   * Verlauf eines Patientendossiers (#205 AK 6/8/9): jüngster Tag zuerst; am
   * selben Tag Sitzungen vor PDF-Dokumenten, darin der jüngste Zeitstempel
   * (Aufnahme bzw. Import) zuerst; die ID macht die Reihenfolge eindeutig.
   * Die Dossier-Plaketten ergänzt der Aufrufer (listForSessions).
   */
  timeline(dossierId: string): Omit<TimelineEntry, 'dossiers'>[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_LIST_COLUMNS}, ${SORT_DAY} AS sort_day
         FROM session_dossiers sd
         JOIN sessions s ON s.id = sd.session_id
         WHERE sd.dossier_id = ? AND s.deleting_at IS NULL
         ORDER BY sort_day DESC, (s.type = 'pdf') ASC, s.created_at DESC, s.id DESC`
      )
      .all(dossierId) as TimelineRow[]
    return rows.map((row) => ({ ...rowToSession(row), sortDay: row.sort_day }))
  }

  sessionExists(sessionId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM sessions WHERE id = ? AND deleting_at IS NULL')
        .get(sessionId) !== undefined
    )
  }

  dossierExists(dossierId: string): boolean {
    return this.db.prepare('SELECT 1 FROM dossiers WHERE id = ?').get(dossierId) !== undefined
  }
}
