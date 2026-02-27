import { z } from 'zod'

export const ManifestModelSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 muss 64 Hex-Zeichen sein'),
  sizeBytes: z.number().int().positive()
})

export const ManifestSchema = z.object({
  generatedAt: z.string().min(1),
  models: z.array(ManifestModelSchema).min(1)
})

export type ManifestModelInput = z.infer<typeof ManifestModelSchema>
export type ManifestInput = z.infer<typeof ManifestSchema>

export const PendingModelUpdateSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 muss 64 Hex-Zeichen sein'),
  sizeBytes: z.number().int().positive(),
  relativePath: z.string().min(1),
  archive: z.boolean().optional(),
  checkPath: z.string().min(1)
})

// Wrapper object schema for the restart IPC handler (matches preload convention: { updates })
export const RestartUpdateSchema = z.object({
  updates: z.array(PendingModelUpdateSchema).min(1)
})
