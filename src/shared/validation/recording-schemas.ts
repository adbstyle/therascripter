import { z } from 'zod'
import { DossierIdSchema } from './dossier-schemas'

/**
 * `recording:start` — ohne Argument oder mit dem Patientendossier, aus dem
 * heraus der USER die Aufnahme startet (#206).
 */
export const RecordingStartSchema = z
  .object({ dossierId: DossierIdSchema.optional() })
  .strict()
  .optional()

export const RecordingStopSchema = z.object({
  sessionId: z.string().min(1)
})

export const RecordingDataSchema = z.object({
  sessionId: z.string().min(1),
  samples: z.instanceof(ArrayBuffer)
})

export type RecordingStopInput = z.infer<typeof RecordingStopSchema>
export type RecordingDataInput = z.infer<typeof RecordingDataSchema>
export type RecordingStartInput = z.infer<typeof RecordingStartSchema>
