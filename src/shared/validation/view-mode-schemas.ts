import { z } from 'zod'

export const ViewModeSchema = z.enum(['pseudonymized', 'plain'])

export const ViewModeSetSchema = z.object({
  mode: ViewModeSchema
})

export type ViewModeSetInput = z.infer<typeof ViewModeSetSchema>
