import { z } from 'zod'

export const ReviewLoadSchema = z.object({
  sessionId: z.string().min(1)
})

export const ReviewSaveSchema = z.object({
  sessionId: z.string().min(1),
  document: z.object({
    type: z.literal('doc'),
    content: z.array(z.any())
  }),
  entityMap: z.record(
    z.string(),
    z.object({
      original: z.string(),
      placeholder: z.string(),
      type: z.enum([
        'PERSON',
        'ORT',
        'DATUM',
        'KONTAKT',
        'ORGANISATION',
        'MEDIZINISCH',
        'SONSTIGES'
      ]),
      source: z.enum(['ner', 'blocklist', 'manual'])
    })
  )
})

export type ReviewLoadInput = z.infer<typeof ReviewLoadSchema>
export type ReviewSaveInput = z.infer<typeof ReviewSaveSchema>
