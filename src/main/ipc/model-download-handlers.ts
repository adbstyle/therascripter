import { ipcMain } from 'electron'
import { statfsSync } from 'fs'
import { getDataDir } from '../db/connection'
import {
  checkModelsExist,
  getModelsToLoad,
  getOverallModelSize,
  startModelDownload
} from '../services/ModelDownloadService'

const MINIMUM_DISK_SPACE_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

export function registerModelDownloadHandlers(): void {
  ipcMain.handle('modelDownload:status', () => {
    return {
      modelsReady: checkModelsExist(),
      // Nur Modelle, die tatsächlich auf First-Launch geladen werden (Pflicht + aktives ASR + aktives Diar),
      // nicht den ganzen Katalog. Sonst zeigt der FirstLaunchScreen ✓-Häkchen für alle positions
      // vor dem aktuellen Download-Index, egal ob die Modelle tatsächlich installiert sind.
      models: getModelsToLoad().map((m) => ({
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
