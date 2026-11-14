import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #209 PC 3: Beim vollständigen Entfernen von Therascript verschwinden die
// letzten Suchanfragen mit der Datenbank — ohne echte Deinstallation geprüft:
// der Handler läuft gegen ein Datenverzeichnis in einem Temp-Ordner.

const env = vi.hoisted(() => ({ home: '', userData: '' }))
const handlers = vi.hoisted(() => new Map<string, (event: unknown, args?: unknown) => unknown>())
const dialogMock = vi.hoisted(() => ({ showMessageBox: vi.fn() }))
const quit = vi.hoisted(() => vi.fn())
const indexStop = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(channel, fn)
  },
  app: {
    getPath: (name: string) => (name === 'userData' ? env.userData : env.home),
    getVersion: () => '0.0.0',
    quit
  },
  dialog: dialogMock,
  shell: { openPath: vi.fn() }
}))
vi.mock('../../search/SearchIndexService', () => ({
  getSearchIndexService: () => ({ stop: indexStop })
}))
vi.mock('../../search/searchRuntime', () => ({ getSearchRuntime: () => null }))

import { registerSystemHandlers } from '../system-handlers'
import { closeDatabase, getDataDir, initDatabase, isDatabaseOpen } from '../../db/connection'
import { SearchRecentRepository } from '../../db/repositories/SearchRecentRepository'

describe('system:uninstall — Suchdaten (#209 PC 3)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'therascript-uninstall-'))
    env.home = join(root, 'home')
    env.userData = join(root, 'userData')
    handlers.clear()
    vi.clearAllMocks()
    registerSystemHandlers()
  })

  afterEach(() => {
    closeDatabase()
    rmSync(root, { recursive: true, force: true })
  })

  it('löscht die Datenbank samt letzten Suchanfragen und stoppt die Aufbereitung', async () => {
    const db = initDatabase()
    new SearchRecentRepository(db).remember('Hofer Prüfungsangst')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM search_recent_queries').get() as { n: number }).n
    ).toBe(1)
    const dataDir = getDataDir()
    expect(readdirSync(join(dataDir, 'data'))).toContain('therascript.db')
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const result = await handlers.get('system:uninstall')!({})

    expect(result).toBe(true)
    expect(indexStop).toHaveBeenCalled()
    expect(isDatabaseOpen()).toBe(false)
    // Datenbank, WAL und SHM liegen im Datenverzeichnis — es ist ganz weg
    expect(existsSync(dataDir)).toBe(false)
    expect(quit).toHaveBeenCalled()
  })

  it('nennt im Bestätigungsdialog Suchindex und letzte Suchanfragen', async () => {
    dialogMock.showMessageBox.mockResolvedValue({ response: 0 })
    const result = await handlers.get('system:uninstall')!({})
    expect(result).toBe(false)
    const options = dialogMock.showMessageBox.mock.calls[0][0] as { detail: string }
    expect(options.detail).toContain('Suchindex und letzte Suchanfragen')
  })
})
