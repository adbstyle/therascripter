import { ipcMain } from 'electron'
import { z } from 'zod'
import { getSettings } from '../services/SettingsService'
import {
  DiarizationPipelineSchema,
  SetDiarizationPipelinePayloadSchema,
  type DiarizationPipeline
} from '../../shared/validation/model-catalog-schemas'

function validate<T>(schema: z.ZodType<T>, payload: unknown, channel: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`IPC ${channel}: ungültige Argumente: ${parsed.error.message}`)
  }
  return parsed.data
}

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:getDiarization', (): DiarizationPipeline => {
    return getSettings().get('activeModels').diarizationPipeline
  })

  ipcMain.handle('pipeline:setDiarization', (_event, payload: unknown) => {
    const { pipeline } = validate(
      SetDiarizationPipelinePayloadSchema,
      payload,
      'pipeline:setDiarization'
    )
    const settings = getSettings()
    const active = settings.get('activeModels')
    settings.set('activeModels', { ...active, diarizationPipeline: pipeline })
    return pipeline
  })

  ipcMain.handle('pipeline:listDiarization', () => {
    return DiarizationPipelineSchema.options
  })
}
