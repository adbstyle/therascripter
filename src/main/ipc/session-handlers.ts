import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { SessionDeleteSchema, SessionRenameSchema } from '../../shared/validation/session-schemas'

export function registerSessionHandlers(): void {
  ipcMain.handle('session:list', () => {
    const service = new SessionService(getDatabase())
    return service.getAllSessions()
  })

  ipcMain.handle('session:delete', (_event, args: unknown) => {
    const { sessionId } = SessionDeleteSchema.parse(args)
    const service = new SessionService(getDatabase())
    return service.deleteSession(sessionId)
  })

  ipcMain.handle('session:rename', (_event, args: unknown) => {
    const { sessionId, title } = SessionRenameSchema.parse(args)
    const service = new SessionService(getDatabase())
    return service.renameSession(sessionId, title)
  })
}
