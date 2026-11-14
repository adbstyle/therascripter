import { z } from 'zod'
import {
  BEFORE_MIN_YEAR_MESSAGE,
  isBeforeMinYear,
  isValidIsoDateNotAfter,
  localTodayIso
} from '../utils/calendar-date'
import {
  hasControlChars,
  hasControlCharsExceptLineBreaks,
  isBlankDossierText
} from '../utils/dossier-normalize'

// IPC-Schemas für Patientendossiers (#204). Längen entsprechen den CHECKs der
// Tabelle `dossiers` (Migration 020). JS zählt UTF-16-Einheiten, SQLite Zeichen —
// ein Wert, der hier passt, passt deshalb auch in die Datenbank.

export const MAX_DOSSIER_NAME_LENGTH = 100
export const MAX_DOSSIER_EXTERNAL_ID_LENGTH = 50
export const MAX_DOSSIER_FREE_TEXT_LENGTH = 20_000

export const DossierIdSchema = z.string().min(1).max(64)

/**
 * Vor- oder Nachname: Pflicht; nur Leerraum oder unsichtbare Zeichen
 * (U+200B–U+200D, U+FEFF) gilt als leer (#204 AK 2). Steuerzeichen
 * (U+0000–U+001F, U+007F, auch Zeilenumbruch und Tab) sind nie erlaubt.
 */
export const DossierNameSchema = z
  .string()
  .max(MAX_DOSSIER_NAME_LENGTH)
  .refine((s) => !hasControlChars(s), { message: 'Name enthält Steuerzeichen' })
  .refine((s) => !isBlankDossierText(s), { message: 'Name darf nicht leer sein' })

/**
 * Patientendossier-ID; leer bzw. nur Leerraum/unsichtbare Zeichen wird als
 * «keine ID» gespeichert. Steuerzeichen sind nie erlaubt.
 */
export const DossierExternalIdSchema = z
  .string()
  .max(MAX_DOSSIER_EXTERNAL_ID_LENGTH)
  .refine((s) => !hasControlChars(s), { message: 'Dossier-ID enthält Steuerzeichen' })

/**
 * Vollständiges, gültiges Kalenderdatum, das nicht nach dem heutigen Tag
 * (lokale Zeit) liegt (#204 AK 8). «Heute» wird bei jeder Prüfung neu bestimmt.
 */
export const PastOrTodayIsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !isBeforeMinYear(d), { message: BEFORE_MIN_YEAR_MESSAGE })
  .refine((d) => isValidIsoDateNotAfter(d, localTodayIso()), {
    message: 'Kein gültiges Datum oder in der Zukunft'
  })

/** Mehrzeiliger Freitext: Zeilenumbruch (LF, CR) und Tab erlaubt, andere Steuerzeichen nicht. */
export const DossierFreeTextSchema = z
  .string()
  .max(MAX_DOSSIER_FREE_TEXT_LENGTH)
  .refine((s) => !hasControlCharsExceptLineBreaks(s), { message: 'Text enthält Steuerzeichen' })

export const DossierCreateSchema = z
  .object({
    firstName: DossierNameSchema,
    lastName: DossierNameSchema,
    externalId: DossierExternalIdSchema.nullable().optional(),
    birthDate: PastOrTodayIsoDateSchema.nullable().optional(),
    confirmDuplicate: z.boolean().optional()
  })
  .strict()

export const DossierPatchSchema = z
  .object({
    firstName: DossierNameSchema.optional(),
    lastName: DossierNameSchema.optional(),
    externalId: DossierExternalIdSchema.nullable().optional(),
    birthDate: PastOrTodayIsoDateSchema.nullable().optional(),
    diagnoses: DossierFreeTextSchema.optional(),
    medication: DossierFreeTextSchema.optional(),
    note: DossierFreeTextSchema.optional()
  })
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'Mindestens ein Feld muss geändert werden'
  })

export const DossierUpdateSchema = z
  .object({
    dossierId: DossierIdSchema,
    patch: DossierPatchSchema
  })
  .strict()

export const DossierIdInputSchema = z.object({ dossierId: DossierIdSchema }).strict()

export const DossierDeleteSchema = z
  .object({
    dossierId: DossierIdSchema,
    fingerprint: z.string().max(128)
  })
  .strict()

/** Sitzungs-ID (UUID, mit Reserve) für Zuordnung und Verlauf (#205). */
export const SessionIdSchema = z.string().min(1).max(64)

/** `dossier:assign` / `dossier:unassign` (#205 AK 1/2). */
export const DossierAssignmentSchema = z
  .object({ sessionId: SessionIdSchema, dossierId: DossierIdSchema })
  .strict()

/** `dossier:listForSession` (#205 AK 5). */
export const SessionIdInputSchema = z.object({ sessionId: SessionIdSchema }).strict()

/**
 * `session:setDocumentDate` (#205 AK 18/21): vollständiges, gültiges
 * Kalenderdatum, nicht nach dem heutigen Tag. Nie null — ein festgelegtes
 * Dokumentdatum lässt sich nicht auf das Importdatum zurücksetzen (OOS 3).
 */
export const SessionDocumentDateSchema = z
  .object({ sessionId: SessionIdSchema, documentDate: PastOrTodayIsoDateSchema })
  .strict()

/** Event `dossiers:changed` — definiert mit den anderen Änderungs-Events. */
export { DossiersChangedSchema } from './change-event-schemas'

export type DossierCreateInput = z.infer<typeof DossierCreateSchema>
export type DossierPatchInput = z.infer<typeof DossierPatchSchema>
export type DossierUpdateInput = z.infer<typeof DossierUpdateSchema>
export type DossierDeleteInput = z.infer<typeof DossierDeleteSchema>
export type DossierAssignmentInput = z.infer<typeof DossierAssignmentSchema>
export type SessionDocumentDateInput = z.infer<typeof SessionDocumentDateSchema>
