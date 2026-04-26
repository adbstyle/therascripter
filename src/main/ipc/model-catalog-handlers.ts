import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  abortModelDownload,
  clearActiveModel,
  deleteModel,
  downloadSingleModel,
  getActiveModelId,
  getModelById,
  getModelsByGroup,
  isModelInstalled,
  setActiveModel
} from '../services/ModelDownloadService'
import {
  ClearActiveModelPayloadSchema,
  ListModelsPayloadSchema,
  ModelIdPayloadSchema,
  SetActiveModelPayloadSchema,
  type ModelCatalogEntry,
  type ModelGroup
} from '../../shared/validation/model-catalog-schemas'

function buildCatalogEntries(group: ModelGroup): ModelCatalogEntry[] {
  const activeId = getActiveModelId(group)
  return getModelsByGroup(group).map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    sizeBytes: def.sizeBytes,
    group,
    isRequired: def.isRequired === true,
    languages: def.languages,
    accuracyScore: def.accuracyScore,
    speedScore: def.speedScore,
    isInstalled: isModelInstalled(def.id),
    isActive: def.id === activeId
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
  ipcMain.handle('modelCatalog:list', (_event, payload: unknown) => {
    const { group } = validate(ListModelsPayloadSchema, payload, 'modelCatalog:list')
    return buildCatalogEntries(group)
  })

  // Backward-compat — kann nach UI-Migration entfernt werden
  ipcMain.handle('modelCatalog:listAsr', () => buildCatalogEntries('asr'))

  ipcMain.handle('modelCatalog:download', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:download')
    await downloadSingleModel(id)
    const def = getModelById(id)
    return buildCatalogEntries(def?.group ?? 'asr')
  })

  ipcMain.handle('modelCatalog:delete', async (_event, payload: unknown) => {
    const { id } = validate(ModelIdPayloadSchema, payload, 'modelCatalog:delete')
    const groupBefore = getModelById(id)?.group ?? 'asr'
    await deleteModel(id)
    return buildCatalogEntries(groupBefore)
  })

  ipcMain.handle('modelCatalog:setActive', (_event, payload: unknown) => {
    const { group, id } = validate(
      SetActiveModelPayloadSchema,
      payload,
      'modelCatalog:setActive'
    )
    setActiveModel(group, id)
    return buildCatalogEntries(group)
  })

  ipcMain.handle('modelCatalog:clearActive', (_event, payload: unknown) => {
    const { group } = validate(
      ClearActiveModelPayloadSchema,
      payload,
      'modelCatalog:clearActive'
    )
    clearActiveModel(group)
    return buildCatalogEntries(group)
  })

  // Cancel läuft gegen dasselbe abortSignal-Singleton, das auch downloadSingleModel nutzt —
  // funktioniert für laufende Downloads, egal ob via First-Launch oder Catalog-API gestartet.
  ipcMain.handle('modelCatalog:cancelDownload', () => {
    abortModelDownload()
  })
}
