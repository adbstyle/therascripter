import { z } from 'zod'

/**
 * Änderungs-Events Main → Renderer (Epic #192) an EINER Stelle: Obergrenze,
 * Payload-Schemas von `sessions:changed` und `dossiers:changed` sowie die
 * Menübefehle `nav:command`. `ChangeEvents.ts` (Main) und der Preload nutzen
 * dieselben Definitionen.
 */

/** Höchstzahl IDs pro Änderungs-Event; grössere Löschungen gehen in Teilen. */
export const MAX_CHANGED_IDS = 1000

/** Sitzungs- und Dossier-IDs (UUID, mit Reserve). */
const ChangedId = z.string().min(1).max(64)

const ChangedIdsSchema = z.object({ deletedIds: z.array(ChangedId).max(MAX_CHANGED_IDS) }).strict()

/** Push `sessions:changed`: gelöschte Sitzungen, sonst leer. */
export const SessionsChangedSchema = ChangedIdsSchema
export type SessionsChangedData = z.infer<typeof SessionsChangedSchema>

/** Push `dossiers:changed`: gelöschte Patientendossiers, sonst leer. */
export const DossiersChangedSchema = ChangedIdsSchema

/** Push `recent:changed` (#213): «Zuletzt geöffnet» neu laden; `deletedIds` immer leer. */
export const RecentChangedSchema = ChangedIdsSchema

/** Push `nav:command` aus den Menüs «Gehe zu» und «Darstellung» (#209 ergänzt 'search'). */
export const NavCommandSchema = z.enum(['back', 'forward', 'toggleSidebar', 'search'])
export type NavCommand = z.infer<typeof NavCommandSchema>
