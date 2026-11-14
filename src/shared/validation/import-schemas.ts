import { z } from 'zod'
import { DossierIdSchema } from './dossier-schemas'

export const ImportPDFSchema = z
  .object({
    filePaths: z.array(z.string().min(1)).min(1).max(20),
    /** #206 — Import aus einem Patientendossier: jedes PDF wird ihm zugeordnet. */
    dossierId: DossierIdSchema.optional()
  })
  .strict()

export type ImportPDFInput = z.infer<typeof ImportPDFSchema>
