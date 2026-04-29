import { z } from 'zod'

export const GetSessionTasksSchema = z.object({
  sessionId: z.string().min(1)
})

export type GetSessionTasksInput = z.infer<typeof GetSessionTasksSchema>

// Issue #80 / Phase D — IPC payload validation for the new task-progress channels.
// These schemas guard payloads received via window.api.tasks.on* listeners so
// that an unexpected main-process message can't crash the renderer.

export const TaskTypeSchema = z.enum([
  'diarization',
  'transcription',
  'alignment',
  'extraction',
  'ocr',
  'anonymization',
  'summarization'
])

export const TaskProgressDataSchema = z.object({
  sessionId: z.string().min(1),
  taskType: TaskTypeSchema,
  progress: z.number().min(0).max(1),
  etaSecondsTotal: z.number().nonnegative().nullable()
})

export const TaskStartedDataSchema = z.object({
  sessionId: z.string().min(1),
  taskType: TaskTypeSchema,
  stepIndex: z.number().int().min(0),
  totalSteps: z.number().int().min(0),
  plannedDurationSec: z.number().positive().nullable()
})

export const TaskCompletedDataSchema = z.object({
  sessionId: z.string().min(1),
  taskType: TaskTypeSchema
})

export const TaskErrorDataSchema = z.object({
  sessionId: z.string().min(1),
  taskType: TaskTypeSchema,
  error: z.string()
})

export const QueuePositionsDataSchema = z.object({
  positions: z.record(z.string().min(1), z.number().int().positive())
})
