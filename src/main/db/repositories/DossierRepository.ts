import type Database from 'better-sqlite3'
import type { Dossier, DossierListItem, DossierRef } from '../../../shared/types/Dossier'
import type { SessionStatus, SessionType } from '../../../shared/types'

interface DossierRow {
  id: string
  first_name: string
  last_name: string
  first_name_norm: string
  last_name_norm: string
  external_id: string | null
  external_id_norm: string | null
  birth_date: string | null
  diagnoses: string
  medication: string
  note: string
  created_at: string
  updated_at: string
}

type DossierRefRow = Pick<
  DossierRow,
  'id' | 'first_name' | 'last_name' | 'external_id' | 'birth_date'
>

interface DossierListRow extends DossierRefRow {
  entry_count: number
  last_entry_day: string | null
}

/**
 * Vollständige Zeile, wie sie DossierService schreibt. Die `*Norm`-Felder
 * berechnet ausschliesslich der Service (normalizeDossierKey) — das Repository
 * normalisiert nie selbst.
 */
export interface DossierRecord {
  id: string
  firstName: string
  lastName: string
  firstNameNorm: string
  lastNameNorm: string
  externalId: string | null
  externalIdNorm: string | null
  birthDate: string | null
  diagnoses: string
  medication: string
  note: string
  createdAt: string
  updatedAt: string
}

/** Spalten-Patch; Namen und Dossier-ID immer zusammen mit ihrem Norm-Wert. */
export interface DossierRecordPatch {
  firstName?: string
  firstNameNorm?: string
  lastName?: string
  lastNameNorm?: string
  externalId?: string | null
  externalIdNorm?: string | null
  birthDate?: string | null
  diagnoses?: string
  medication?: string
  note?: string
}

/** Eine einem Dossier zugeordnete Sitzung samt Anzahl weiterer Dossiers. */
export interface DossierSessionScopeRow {
  id: string
  type: SessionType
  status: SessionStatus
  otherCount: number
}

const COLUMN_OF: Record<keyof DossierRecordPatch, string> = {
  firstName: 'first_name',
  firstNameNorm: 'first_name_norm',
  lastName: 'last_name',
  lastNameNorm: 'last_name_norm',
  externalId: 'external_id',
  externalIdNorm: 'external_id_norm',
  birthDate: 'birth_date',
  diagnoses: 'diagnoses',
  medication: 'medication',
  note: 'note'
}

function rowToDossier(row: DossierRow): Dossier {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    externalId: row.external_id,
    birthDate: row.birth_date,
    diagnoses: row.diagnoses,
    medication: row.medication,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToRef(row: DossierRefRow): DossierRef {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    externalId: row.external_id,
    birthDate: row.birth_date
  }
}

const REF_COLUMNS = 'd.id, d.first_name, d.last_name, d.external_id, d.birth_date'
const NAME_ORDER = 'd.last_name_norm, d.first_name_norm, d.id'

export class DossierRepository {
  constructor(private db: Database.Database) {}

  create(record: DossierRecord): Dossier {
    this.db
      .prepare(
        `INSERT INTO dossiers (id, first_name, last_name, first_name_norm, last_name_norm,
           external_id, external_id_norm, birth_date, diagnoses, medication, note,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.firstName,
        record.lastName,
        record.firstNameNorm,
        record.lastNameNorm,
        record.externalId,
        record.externalIdNorm,
        record.birthDate,
        record.diagnoses,
        record.medication,
        record.note,
        record.createdAt,
        record.updatedAt
      )
    return this.findById(record.id)!
  }

  findById(id: string): Dossier | null {
    const row = this.db.prepare('SELECT * FROM dossiers WHERE id = ?').get(id) as
      | DossierRow
      | undefined
    return row ? rowToDossier(row) : null
  }

  findRefById(id: string): DossierRef | null {
    const row = this.db.prepare(`SELECT ${REF_COLUMNS} FROM dossiers d WHERE d.id = ?`).get(id) as
      | DossierRefRow
      | undefined
    return row ? rowToRef(row) : null
  }

  /** Schreibt nur die übergebenen Spalten (Autosave pro Feld) und setzt updated_at. */
  update(id: string, patch: DossierRecordPatch, updatedAt: string): Dossier | null {
    const sets: string[] = []
    const values: unknown[] = []
    for (const key of Object.keys(COLUMN_OF) as (keyof DossierRecordPatch)[]) {
      if (patch[key] === undefined) continue
      sets.push(`${COLUMN_OF[key]} = ?`)
      values.push(patch[key])
    }
    sets.push('updated_at = ?')
    values.push(updatedAt, id)
    const result = this.db
      .prepare(`UPDATE dossiers SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
    return result.changes > 0 ? this.findById(id) : null
  }

  /** Zuordnungen und «Zuletzt»-Einträge gehen per ON DELETE CASCADE mit. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM dossiers WHERE id = ?').run(id).changes > 0
  }

  findByExternalIdNorm(externalIdNorm: string, excludeId?: string): DossierRef | null {
    const row = this.db
      .prepare(
        `SELECT ${REF_COLUMNS} FROM dossiers d
         WHERE d.external_id_norm = ? AND d.id IS NOT ?`
      )
      .get(externalIdNorm, excludeId ?? null) as DossierRefRow | undefined
    return row ? rowToRef(row) : null
  }

  findSameName(firstNameNorm: string, lastNameNorm: string, excludeId?: string): DossierRef[] {
    const rows = this.db
      .prepare(
        `SELECT ${REF_COLUMNS} FROM dossiers d
         WHERE d.last_name_norm = ? AND d.first_name_norm = ? AND d.id IS NOT ?
         ORDER BY ${NAME_ORDER}`
      )
      .all(lastNameNorm, firstNameNorm, excludeId ?? null) as DossierRefRow[]
    return rows.map(rowToRef)
  }

  /**
   * Übersicht (#204 AK 12/15): alphabetisch nach Nachname, dann Vorname (ä wie
   * ae, konsistent zur Gleichheitsregel), mit Anzahl und Tag des jüngsten
   * Eintrags. Sitzungen im Löschen (deleting_at) zählen nicht. Der Tag eines
   * PDFs ist sein Dokumentdatum, sonst der lokale Tag des Imports.
   */
  listSummaries(): DossierListItem[] {
    const rows = this.db
      .prepare(
        `SELECT ${REF_COLUMNS},
                COUNT(s.id) AS entry_count,
                MAX(CASE WHEN s.type = 'pdf'
                         THEN COALESCE(s.document_date, date(s.created_at, 'localtime'))
                         ELSE date(s.created_at, 'localtime') END) AS last_entry_day
         FROM dossiers d
         LEFT JOIN session_dossiers sd ON sd.dossier_id = d.id
         LEFT JOIN sessions s ON s.id = sd.session_id AND s.deleting_at IS NULL
         GROUP BY d.id
         ORDER BY ${NAME_ORDER}`
      )
      .all() as DossierListRow[]
    return rows.map((row) => ({
      ...rowToRef(row),
      entryCount: row.entry_count,
      lastEntryDay: row.last_entry_day
    }))
  }

  /** Alle zugeordneten Sitzungen (ohne solche im Löschen) mit Anzahl weiterer Dossiers. */
  findSessionScope(dossierId: string): DossierSessionScopeRow[] {
    return this.db
      .prepare(
        `SELECT s.id, s.type, s.status,
                (SELECT COUNT(*) FROM session_dossiers o
                 WHERE o.session_id = s.id AND o.dossier_id <> sd.dossier_id) AS otherCount
         FROM session_dossiers sd
         JOIN sessions s ON s.id = sd.session_id
         WHERE sd.dossier_id = ? AND s.deleting_at IS NULL
         ORDER BY s.id`
      )
      .all(dossierId) as DossierSessionScopeRow[]
  }

  /** Andere Dossiers, mit denen dieses Dossier Sitzungen teilt. */
  findDossiersSharingSessions(dossierId: string): DossierRef[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ${REF_COLUMNS}, d.last_name_norm, d.first_name_norm
         FROM session_dossiers sd
         JOIN sessions s ON s.id = sd.session_id AND s.deleting_at IS NULL
         JOIN session_dossiers o ON o.session_id = sd.session_id AND o.dossier_id <> sd.dossier_id
         JOIN dossiers d ON d.id = o.dossier_id
         WHERE sd.dossier_id = ?
         ORDER BY ${NAME_ORDER}`
      )
      .all(dossierId) as DossierRefRow[]
    return rows.map(rowToRef)
  }
}
