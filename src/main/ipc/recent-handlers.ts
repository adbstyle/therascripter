import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { RecentService } from '../services/RecentService'
import { getActiveSessionId } from './recording-handlers'
import { validateIpc } from '../utils/ipc-helpers'
import { RecentTouchSchema } from '../../shared/validation/recent-schemas'
import type { RecentEntry } from '../../shared/types/Recent'

// IPC für «Zuletzt geöffnet» (#213).

type Service = Pick<RecentService, 'list' | 'touch'>

export function handleRecentList(service: Service): RecentEntry[] {
  return service.list()
}

export function handleRecentTouch(service: Service, args: unknown): void {
  service.touch(validateIpc(RecentTouchSchema, args, 'recent:touch'))
}

export function registerRecentHandlers(
  createService: () => Service = () => new RecentService(getDatabase(), { getActiveSessionId })
): void {
  ipcMain.handle('recent:list', () => handleRecentList(createService()))
  ipcMain.handle('recent:touch', (_event, args: unknown) =>
    handleRecentTouch(createService(), args)
  )
}
