import { z } from 'zod'

export const RecordingStopSchema = z.object({
  sessionId: z.string().min(1)
})

export const RecordingDataSchema = z.object({
  sessionId: z.string().min(1),
  samples: z.instanceof(ArrayBuffer)
})

export type RecordingStopInput = z.infer<typeof RecordingStopSchema>
export type RecordingDataInput = z.infer<typeof RecordingDataSchema>
