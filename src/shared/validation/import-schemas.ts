import { z } from 'zod'

export const ImportPDFSchema = z.object({
  filePaths: z.array(z.string().min(1)).min(1).max(20)
})

export type ImportPDFInput = z.infer<typeof ImportPDFSchema>
