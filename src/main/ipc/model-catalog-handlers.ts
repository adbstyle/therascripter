import { ipcMain } from 'electron'
import { z } from 'zod'
import { getSettings } from '../services/SettingsService'
import {
  abortModelDownload,
  deleteModel,
  downloadSingleModel,
  getAsrModels,
  isModelInstalled,
  setActiveAsrModel
} from '../services/ModelDownloadService'
import {
  ModelIdPayloadSchema,
  type ModelCatalogEntry
} from '../../shared/validation/model-catalog-schemas'

function buildCatalogEntries(): ModelCatalogEntry[] {
  const activeAsr = getSettings().get('activeModels').transcription
  return getAsrModels().map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    sizeBytes: def.sizeBytes,
    group: 'asr' as const,
    isRequired: def.isRequired === true,
    languages: def.languages,
    accuracyScore: def.accuracyScore,
    speedScore: def.speedScore,
    isInstalled: isModelInstalled(def.id),
    isActive: def.id === activeAsr
  }))
}

function validate<T>(schema: z.ZodType<T>, payload: unknown, channel: string): T {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`IPC ${channel}: ungültige Argumente: ${parsed.error.message}`)
  }
  return parsed.data
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('modelCatalog:listAsr', () => {
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:download', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:download')
    await downloadSingleModel(id)
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:delete', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:delete')
    await deleteModel(id)
    return buildCatalogEntries()
  })

  ipcMain.handle('modelCatalog:setActive', (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:setActive')
    setActiveAsrModel(id)
    return buildCatalogEntries()
  })

  // Cancel läuft gegen dasselbe abortSignal-Singleton, das auch downloadSingleModel nutzt —
  // funktioniert für laufende Downloads, egal ob via First-Launch oder Catalog-API gestartet.
  ipcMain.handle('modelCatalog:cancelDownload', () => {
    abortModelDownload()
  })
}
