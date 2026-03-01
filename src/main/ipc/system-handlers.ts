import { app, dialog, ipcMain, shell } from 'electron'
import { execSync } from 'child_process'
import { rmSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { release, totalmem } from 'os'
import { z } from 'zod'
import { getDatabase, getDataDir, closeDatabase } from '../db/connection'
import type { AboutInfo } from '../../shared/types'

function getChipName(): string {
  try {
    return execSync('sysctl -n machdep.cpu.brand_string', {
      encoding: 'utf-8',
      timeout: 3000
    }).trim()
  } catch {
    return 'Unbekannt'
  }
}

function getFileVaultStatus(): boolean | null {
  try {
    const output = execSync('fdesetup status', { encoding: 'utf-8', timeout: 3000 })
    return output.includes('FileVault is On')
  } catch {
    return null
  }
}

function getDirSizeBytes(dirPath: string): number {
  let total = 0
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isFile()) {
        try {
          total += statSync(fullPath).size
        } catch {
          // Skip inaccessible files
        }
      } else if (entry.isDirectory()) {
        total += getDirSizeBytes(fullPath)
      }
    }
  } catch {
    // Directory may not exist
  }
  return total
}

export function registerSystemHandlers(): void {
  ipcMain.handle('system:aboutInfo', (): AboutInfo => {
    const dataDir = getDataDir()
    const modelsDir = join(dataDir, 'models')

    const sessionDirs = ['audio', 'transcripts', 'anonymized', 'diarization', 'pdf', 'extracted']
    let sessionsBytes = 0
    for (const dir of sessionDirs) {
      sessionsBytes += getDirSizeBytes(join(dataDir, dir))
    }

    // Include database size
    try {
      sessionsBytes += statSync(join(dataDir, 'data', 'therascript.db')).size
    } catch {
      // DB file may not exist in rare cases
    }

    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      osVersion: release(),
      chip: getChipName(),
      totalMemoryGB: Math.round(totalmem() / (1024 * 1024 * 1024)),
      fileVaultActive: getFileVaultStatus(),
      storageModelsBytes: getDirSizeBytes(modelsDir),
      storageSessionsBytes: sessionsBytes,
      dataDir
    }
  })

  ipcMain.handle('system:openInFinder', (_event, args: unknown) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(args)
    shell.openPath(path)
  })

  ipcMain.handle('system:uninstall', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Therascript vollständig entfernen',
      message: 'Alle Daten werden unwiderruflich gelöscht:',
      detail:
        '• ML-Modelle (~4 GB)\n' +
        '• Alle Sitzungen und Audiodateien\n' +
        '• Sperrliste\n' +
        '• Einstellungen\n\n' +
        'Die App-Datei (Therascript.app) muss anschliessend ' +
        'manuell aus dem Applications-Ordner gelöscht werden.',
      buttons: ['Abbrechen', 'Entfernen'],
      defaultId: 0,
      cancelId: 0
    })

    if (response !== 1) return false

    try {
      // VACUUM before deleting to compact DB (cleaner removal)
      getDatabase().exec('VACUUM')
    } catch {
      // DB may already be in error state
    }

    closeDatabase()

    const errors: string[] = []
    const dataDir = getDataDir()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch (error) {
      console.error('Failed to remove data directory:', error)
      errors.push(`Datenverzeichnis: ${(error as Error).message}`)
    }

    // Also remove electron-store settings
    const settingsDir = app.getPath('userData')
    try {
      rmSync(settingsDir, { recursive: true, force: true })
    } catch (error) {
      console.error('Failed to remove settings directory:', error)
      errors.push(`Einstellungen: ${(error as Error).message}`)
    }

    if (errors.length > 0) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Deinstallation unvollständig',
        message: 'Einige Daten konnten nicht gelöscht werden:',
        detail: errors.join('\n') + '\n\nBitte manuell entfernen:\n' + dataDir,
        buttons: ['OK']
      })
    }

    app.quit()
    return true
  })
}
