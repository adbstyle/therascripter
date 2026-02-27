import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { BlocklistRepository } from '../db/repositories/BlocklistRepository'
import {
  BlocklistAddSchema,
  BlocklistUpdateSchema,
  BlocklistDeleteSchema
} from '../../shared/validation/blocklist-schemas'

export function registerBlocklistHandlers(): void {
  ipcMain.handle('blocklist:list', () => {
    const repo = new BlocklistRepository(getDatabase())
    return repo.findAll()
  })

  ipcMain.handle('blocklist:add', (_event, args: unknown) => {
    const { term, placeholderType } = BlocklistAddSchema.parse(args)
    const repo = new BlocklistRepository(getDatabase())
    return repo.create(term, placeholderType)
  })

  ipcMain.handle('blocklist:update', (_event, args: unknown) => {
    const { id, term, placeholderType } = BlocklistUpdateSchema.parse(args)
    const repo = new BlocklistRepository(getDatabase())
    return repo.update(id, term, placeholderType)
  })

  ipcMain.handle('blocklist:delete', (_event, args: unknown) => {
    const { id } = BlocklistDeleteSchema.parse(args)
    const repo = new BlocklistRepository(getDatabase())
    return repo.delete(id)
  })
}
