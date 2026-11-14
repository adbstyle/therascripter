import { z } from 'zod'
import { SEARCH_MAX_QUERY_LENGTH } from '../search-config'
import { DossierIdSchema } from './dossier-schemas'

// IPC-Schemas der Suche (Epic #192 — #209, #211). Alle `.strict()`: ein
// unbekanntes Feld ist ein Programmierfehler, kein Wunsch.

/** Steuerzeichen U+0000–U+001F und U+007F — in einer Suchanfrage nie sinnvoll. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

export const SearchQueryTextSchema = z
  .string()
  .min(1)
  .max(SEARCH_MAX_QUERY_LENGTH)
  .refine((s) => s.trim().length > 0, { message: 'Suchanfrage darf nicht leer sein' })
  .refine((s) => !CONTROL_CHARS.test(s), { message: 'Suchanfrage enthält Steuerzeichen' })

export const SearchScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('dossier'), dossierId: DossierIdSchema }).strict()
])

export const SearchQueryInputSchema = z
  .object({
    requestId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    query: SearchQueryTextSchema,
    scope: SearchScopeSchema
  })
  .strict()

export const SearchRecentRememberSchema = z.object({ query: SearchQueryTextSchema }).strict()
