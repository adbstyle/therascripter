import { z } from 'zod'

export const ModelGroupSchema = z.enum(['asr', 'diarization', 'ner', 'summarization'])
export type ModelGroup = z.infer<typeof ModelGroupSchema>

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string(),
  description: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  group: ModelGroupSchema,
  isRequired: z.boolean(),
  languages: z.array(z.string()).optional(),
  accuracyScore: z.number().min(0).max(1).optional(),
  speedScore: z.number().min(0).max(1).optional(),
  isInstalled: z.boolean(),
  isActive: z.boolean()
})

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

const modelIdStringSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9.-]+$/i, 'nur a-z, 0-9, Bindestrich und Punkt erlaubt')

export const ModelIdPayloadSchema = z.object({
  id: modelIdStringSchema
})

/** Payload für modelCatalog:list(group). */
export const ListModelsPayloadSchema = z.object({
  group: ModelGroupSchema
})

/** Payload für modelCatalog:setActive — braucht group, um den Settings-Slot zu adressieren. */
export const SetActiveModelPayloadSchema = z.object({
  group: ModelGroupSchema,
  id: modelIdStringSchema
})

/** Erlaubte Diarization-Pipelines (HuggingFace-Identifier). */
export const DiarizationPipelineSchema = z.enum([
  'pyannote/speaker-diarization-3.1',
  'pyannote/speaker-diarization-community-1'
])
export type DiarizationPipeline = z.infer<typeof DiarizationPipelineSchema>
export const DIARIZATION_PIPELINES = DiarizationPipelineSchema.options
export const DEFAULT_DIARIZATION_PIPELINE: DiarizationPipeline = DIARIZATION_PIPELINES[0]

/** Payload für pipeline:setDiarization. */
export const SetDiarizationPipelinePayloadSchema = z.object({
  pipeline: DiarizationPipelineSchema
})
