import { z } from 'zod'

const PlaceholderTypeSchema = z.enum([
  'PERSON',
  'ORT',
  'DATUM',
  'KONTAKT',
  'ORGANISATION',
  'MEDIZINISCH',
  'SONSTIGES'
])

export const BlocklistAddSchema = z.object({
  term: z.string().min(1).max(200),
  placeholderType: PlaceholderTypeSchema
})

export const BlocklistUpdateSchema = z.object({
  id: z.string().min(1),
  term: z.string().min(1).max(200),
  placeholderType: PlaceholderTypeSchema
})

export const BlocklistDeleteSchema = z.object({
  id: z.string().min(1)
})

export type BlocklistAddInput = z.infer<typeof BlocklistAddSchema>
export type BlocklistUpdateInput = z.infer<typeof BlocklistUpdateSchema>
export type BlocklistDeleteInput = z.infer<typeof BlocklistDeleteSchema>
