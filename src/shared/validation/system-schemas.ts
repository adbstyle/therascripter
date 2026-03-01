import { z } from 'zod'

export const OpenInFinderSchema = z.object({
  path: z.string().min(1)
})

export type OpenInFinderInput = z.infer<typeof OpenInFinderSchema>
