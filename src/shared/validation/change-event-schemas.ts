import { z } from 'zod'

/** Höchstzahl IDs pro Änderungs-Event; grössere Löschungen gehen in Teilen. */
export const MAX_CHANGED_IDS = 1000

const Id = z.string().min(1).max(64)

/** Push `sessions:changed` (Epic #192): gelöschte Sitzungen, sonst leer. */
export const SessionsChangedSchema = z
  .object({ deletedIds: z.array(Id).max(MAX_CHANGED_IDS) })
  .strict()

export type SessionsChangedData = z.infer<typeof SessionsChangedSchema>

/** Push `nav:command` aus dem Menü «Gehe zu» (Epic #192; #209 ergänzt 'search'). */
export const NavCommandSchema = z.enum(['back', 'forward', 'toggleSidebar'])

export type NavCommand = z.infer<typeof NavCommandSchema>
