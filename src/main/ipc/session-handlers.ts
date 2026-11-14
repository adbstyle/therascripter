import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { SessionService } from '../services/SessionService'
import { SessionDossierService } from '../services/SessionDossierService'
import { SessionDeleteSchema, SessionRenameSchema } from '../../shared/validation/session-schemas'
import { SessionDocumentDateSchema } from '../../shared/validation/dossier-schemas'
import { validateIpc } from '../utils/ipc-helpers'

export function registerSessionHandlers(): void {
  // #205: mit den Patientendossiers jeder Sitzung (zweite Abfrage, kein GROUP_CONCAT)
  ipcMain.handle('session:list', () => new SessionDossierService(getDatabase()).listSessions())

  ipcMain.handle('session:setDocumentDate', (_event, args: unknown) => {
    const { sessionId, documentDate } = validateIpc(
      SessionDocumentDateSchema,
      args,
      'session:setDocumentDate'
    )
    return new SessionService(getDatabase()).setDocumentDate(sessionId, documentDate)
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
