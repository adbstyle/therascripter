import { ipcMain } from 'electron'
import { statfsSync } from 'fs'
import { getDataDir } from '../db/connection'
import {
  checkModelsExist,
  getModelDefinitions,
  getOverallModelSize,
  startModelDownload
} from '../services/ModelDownloadService'

const MINIMUM_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

export function registerModelDownloadHandlers(): void {
  ipcMain.handle('modelDownload:status', () => {
    return {
      modelsReady: checkModelsExist(),
      models: getModelDefinitions().map((m) => ({
        id: m.id,
        label: m.label,
        sizeBytes: m.sizeBytes
      }))
    }
  })

  ipcMain.handle('modelDownload:checkDiskSpace', () => {
    try {
      const stats = statfsSync(getDataDir())
      const availableBytes = stats.bavail * stats.bsize
      const requiredBytes = getOverallModelSize()
      return {
        sufficient: availableBytes >= MINIMUM_DISK_SPACE_BYTES,
        availableBytes,
        requiredBytes
      }
    } catch {
      return { sufficient: true, availableBytes: 0, requiredBytes: 0 }
    }
  })

  ipcMain.handle('modelDownload:start', async () => {
    await startModelDownload()
  })
}
