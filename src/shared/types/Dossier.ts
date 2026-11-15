import type { Session } from './Session'

/**
 * Patientendossiers (Epic #192, Story #204).
 *
 * Datumsfelder sind ISO-Kalendertage (`YYYY-MM-DD`), Zeitstempel ISO-UTC.
 * Leere optionale Angaben: `externalId`/`birthDate` = null, Freitexte = ''.
 */

/** Alle Angaben eines Patientendossiers (Detailansicht). */
export interface Dossier {
  id: string
  firstName: string
  lastName: string
  /** Patientendossier-ID, z. B. aus der Praxissoftware; eindeutig nach Normalisierung (#204 AK 5/7). */
  externalId: string | null
  birthDate: string | null
  diagnoses: string
  medication: string
  note: string
  createdAt: string
  updatedAt: string
}

/** Kurzform zur Unterscheidung gleichnamiger Personen (Plaketten, Hinweise, Auswahl). */
export interface DossierRef {
  id: string
  firstName: string
  lastName: string
  externalId: string | null
  birthDate: string | null
}

/**
 * Zeile der Übersicht. Diagnosen, Medikation und Notiz gehen bewusst nicht mit
 * (weniger Gesundheitsdaten im Renderer, als die Übersicht braucht).
 */
export interface DossierListItem extends DossierRef {
  /** Anzahl zugeordneter Sitzungen und PDF-Dokumente (ohne solche im Löschen). */
  entryCount: number
  /** Tag des jüngsten Eintrags (`YYYY-MM-DD`, lokale Zeit) oder null ohne Einträge. */
  lastEntryDay: string | null
  /**
   * Angelegt (ISO-UTC). Unterscheidet gleichnamige Dossiers ohne ID und
   * Geburtsdatum («angelegt am 05.11.2026 · 3 Einträge»).
   */
  createdAt: string
}

/** Eingabe für `dossier:create`. */
export interface CreateDossierInput {
  firstName: string
  lastName: string
  externalId?: string | null
  birthDate?: string | null
  /** true, nachdem der USER den Hinweis auf gleiche Namen gesehen hat (#204 AK 6). */
  confirmDuplicate?: boolean
}

/** Einzelfeld-Patch für `dossier:update` (Autosave, mind. ein Feld). */
export interface DossierPatch {
  firstName?: string
  lastName?: string
  externalId?: string | null
  birthDate?: string | null
  diagnoses?: string
  medication?: string
  note?: string
}

/**
 * `ownerName` ist der Name des Dossiers, das die ID bereits trägt, als
 * «Nachname, Vorname» (wie in der Übersicht).
 */
export type CreateDossierResult =
  | { ok: true; dossier: Dossier }
  | { ok: false; reason: 'external-id-taken'; ownerName: string }
  | { ok: false; reason: 'duplicate-name'; duplicates: DossierRef[] }

/**
 * Gleicher Name blockiert eine Änderung nie (#204 AK 6): gespeichert wird
 * trotzdem, `duplicates` nennt die anderen Dossiers mit demselben Namen.
 */
export type UpdateDossierResult =
  | { ok: true; dossier: Dossier; duplicates: DossierRef[] }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'external-id-taken'; ownerName: string }

/** Was das Löschen eines Patientendossiers mitnimmt (#204 AK 17, #207). */
export interface DossierDeletePreview {
  dossierId: string
  /** «Vorname Nachname» für den Dialogtitel. */
  displayName: string
  /** Nur diesem Dossier zugeordnet — wird mitgelöscht. */
  exclusive: { sessions: number; pdfs: number }
  /** Auch anderen Dossiers zugeordnet — bleibt erhalten. */
  shared: { sessions: number; pdfs: number; otherDossiers: DossierRef[] }
  /**
   * Suchdaten, die mitgelöscht werden (#207, Epic EK 22): wie viele der
   * mitgelöschten Inhalte für die Suche aufbereitete Texte haben (bzw. gleich
   * bekommen), und wie viele letzte Suchanfragen Namen oder ID des Dossiers
   * enthalten.
   */
  search: { exclusiveSearchable: number; recentQueries: number }
  /** Eine exklusiv zugeordnete Sitzung wird gerade aufgenommen — Löschen gesperrt (#207 AK 2). */
  blockedByRecording: boolean
  /** Stand der Vorschau; `dossier:delete` löscht nur, wenn er noch stimmt (#207 AK 1). */
  fingerprint: string
}

export type DeleteDossierResult =
  | { ok: true; deletedSessionIds: string[]; incomplete: boolean }
  | { ok: false; reason: 'blocked-recording' | 'not-found' }
  | { ok: false; reason: 'changed'; preview: DossierDeletePreview }

/* ---------------------------------------------------------------------------
 * Zuordnen, Verlauf, Dokumentdatum (#205)
 * ------------------------------------------------------------------------- */

/**
 * Eintrag der Sitzungsliste (`session:list`): Listen-Projektion einer Sitzung
 * mit den Patientendossiers, denen sie zugeordnet ist — alphabetisch nach
 * Nachname, dann Vorname (#205 AK 5).
 */
export type SessionListItem = Session & { dossiers: DossierRef[] }

/**
 * Eintrag im Verlauf eines Patientendossiers (#205 AK 6–14). `sortDay` ist der
 * Tag, der die Stelle im Verlauf bestimmt (`YYYY-MM-DD`, lokale Zeit): bei
 * Sitzungen der Tag der Aufnahme, bei PDF-Dokumenten das Dokumentdatum, sonst
 * der Tag des Imports. Der Main-Prozess rechnet ihn aus — Renderer und Main
 * können so nie mit verschiedenen Tagesgrenzen gruppieren.
 */
export type TimelineEntry = SessionListItem & { sortDay: string }

/** Ergebnis von `dossier:assign` / `dossier:unassign`. */
export type DossierAssignmentResult = { ok: true } | { ok: false; reason: 'not-found' }

/** Ergebnis von `session:setDocumentDate` (#205 AK 18–22). */
export type SetDocumentDateResult = { ok: true } | { ok: false; reason: 'not-found' | 'not-pdf' }
