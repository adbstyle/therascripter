import { z } from 'zod'

const Id = z.string().min(1).max(64)

/** `recent:touch` — geöffnetes Dossier oder geöffnete Sitzung (#213). */
export const RecentTouchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dossier'), id: Id }).strict(),
  z.object({ kind: z.literal('session'), id: Id }).strict()
])
