import { z } from 'zod'

/**
 * Gruppen mit einem Slot in `activeModels` (wählbar, aktivierbar). Die Gruppe
 * `search` (Epic #192) hat KEINEN Slot: es gibt genau ein Suchmodell, es wird
 * weder aktiviert noch gelöscht. Alles, was einen Slot adressiert, nimmt
 * deshalb `SlotModelGroup` — der Compiler zeigt so jede Stelle, die die neue
 * Gruppe vergisst.
 */
export const SLOT_MODEL_GROUPS = ['asr', 'diarization', 'ner', 'summarization'] as const
export const SlotModelGroupSchema = z.enum(SLOT_MODEL_GROUPS)
export type SlotModelGroup = z.infer<typeof SlotModelGroupSchema>

export const ModelGroupSchema = z.enum([...SLOT_MODEL_GROUPS, 'search'])
export type ModelGroup = z.infer<typeof ModelGroupSchema>

export function isSlotModelGroup(group: ModelGroup): group is SlotModelGroup {
  return (SLOT_MODEL_GROUPS as readonly string[]).includes(group)
}

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string(),
  description: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  group: SlotModelGroupSchema,
  isRequired: z.boolean(),
  languages: z.array(z.string()).optional(),
  accuracyScore: z.number().min(0).max(1).optional(),
  speedScore: z.number().min(0).max(1).optional(),
  /** HuggingFace repo path (e.g. "flair/ner-german-large"). Renderer renders an external link. */
  hfRepo: z.string().optional(),
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
  group: SlotModelGroupSchema
})

/** Payload für modelCatalog:setActive — braucht group, um den Settings-Slot zu adressieren. */
export const SetActiveModelPayloadSchema = z.object({
  group: SlotModelGroupSchema,
  id: modelIdStringSchema
})

/** Payload für modelCatalog:clearActive — leert den Active-Slot einer optionalen Gruppe. */
export const ClearActiveModelPayloadSchema = z.object({
  group: SlotModelGroupSchema
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
