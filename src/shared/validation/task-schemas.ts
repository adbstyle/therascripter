import { z } from 'zod'

export const GetSessionTasksSchema = z.object({
  sessionId: z.string().min(1)
})

export type GetSessionTasksInput = z.infer<typeof GetSessionTasksSchema>
