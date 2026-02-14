import { z } from 'zod'

export const SessionDeleteSchema = z.object({
  sessionId: z.string().min(1)
})

export const SessionRenameSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1).max(200)
})

export type SessionDeleteInput = z.infer<typeof SessionDeleteSchema>
export type SessionRenameInput = z.infer<typeof SessionRenameSchema>
