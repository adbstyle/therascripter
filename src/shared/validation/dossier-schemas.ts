import { z } from 'zod'
import { isValidIsoDateNotAfter, localTodayIso } from '../utils/calendar-date'

// IPC-Schemas für Patientendossiers (#204). Längen entsprechen den CHECKs der
// Tabelle `dossiers` (Migration 020). JS zählt UTF-16-Einheiten, SQLite Zeichen —
// ein Wert, der hier passt, passt deshalb auch in die Datenbank.

export const MAX_DOSSIER_NAME_LENGTH = 100
export const MAX_DOSSIER_EXTERNAL_ID_LENGTH = 50
export const MAX_DOSSIER_FREE_TEXT_LENGTH = 20_000

export const DossierIdSchema = z.string().min(1).max(64)

/** Vor- oder Nachname: Pflicht, nur Leerzeichen gilt als leer (#204 AK 2). */
export const DossierNameSchema = z
  .string()
  .max(MAX_DOSSIER_NAME_LENGTH)
  .refine((s) => s.trim().length > 0, { message: 'Name darf nicht leer sein' })

/** Patientendossier-ID; leer bzw. nur Leerzeichen wird als «keine ID» gespeichert. */
export const DossierExternalIdSchema = z.string().max(MAX_DOSSIER_EXTERNAL_ID_LENGTH)

/**
 * Vollständiges, gültiges Kalenderdatum, das nicht nach dem heutigen Tag
 * (lokale Zeit) liegt (#204 AK 8). «Heute» wird bei jeder Prüfung neu bestimmt.
 */
export const PastOrTodayIsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => isValidIsoDateNotAfter(d, localTodayIso()), {
    message: 'Kein gültiges Datum oder in der Zukunft'
  })

export const DossierFreeTextSchema = z.string().max(MAX_DOSSIER_FREE_TEXT_LENGTH)

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

/** Event `dossiers:changed` (Main → Renderer). */
export const DossiersChangedSchema = z
  .object({
    deletedIds: z.array(DossierIdSchema).max(1000)
  })
  .strict()

export type DossierCreateInput = z.infer<typeof DossierCreateSchema>
export type DossierPatchInput = z.infer<typeof DossierPatchSchema>
export type DossierUpdateInput = z.infer<typeof DossierUpdateSchema>
export type DossierDeleteInput = z.infer<typeof DossierDeleteSchema>
