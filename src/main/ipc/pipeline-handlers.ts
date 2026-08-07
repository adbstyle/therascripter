import { ipcMain } from 'electron'
import { validateIpc } from '../utils/ipc-helpers'
import { getSettings } from '../services/SettingsService'
import {
  DiarizationPipelineSchema,
  SetDiarizationPipelinePayloadSchema,
  type DiarizationPipeline
} from '../../shared/validation/model-catalog-schemas'

export function registerPipelineHandlers(): void {
  ipcMain.handle('pipeline:getDiarization', (): DiarizationPipeline => {
    return getSettings().get('activeModels').diarizationPipeline
  })

  ipcMain.handle('pipeline:setDiarization', (_event, payload: unknown) => {
    const { pipeline } = validateIpc(
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
