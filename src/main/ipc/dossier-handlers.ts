import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { DossierService } from '../services/DossierService'
import { getActiveSessionId } from './recording-handlers'
import { validateIpc } from '../utils/ipc-helpers'
import {
  DossierCreateSchema,
  DossierDeleteSchema,
  DossierIdInputSchema,
  DossierUpdateSchema
} from '../../shared/validation/dossier-schemas'
import type {
  CreateDossierResult,
  DeleteDossierResult,
  Dossier,
  DossierDeletePreview,
  DossierListItem,
  UpdateDossierResult
} from '../../shared/types/Dossier'

// IPC für Patientendossiers (#204). #205 ergänzt timeline, listForSession,
// assign und unassign hier in eigenen Handlern.

type Service = Pick<
  DossierService,
  'list' | 'get' | 'create' | 'update' | 'deletePreview' | 'deleteDossier'
>

export function handleDossierList(service: Service): DossierListItem[] {
  return service.list()
}

export function handleDossierGet(service: Service, args: unknown): Dossier | null {
  const { dossierId } = validateIpc(DossierIdInputSchema, args, 'dossier:get')
  return service.get(dossierId)
}

export function handleDossierCreate(service: Service, args: unknown): CreateDossierResult {
  return service.create(validateIpc(DossierCreateSchema, args, 'dossier:create'))
}

export function handleDossierUpdate(service: Service, args: unknown): UpdateDossierResult {
  const { dossierId, patch } = validateIpc(DossierUpdateSchema, args, 'dossier:update')
  return service.update(dossierId, patch)
}

export function handleDossierDeletePreview(
  service: Service,
  args: unknown
): DossierDeletePreview | null {
  const { dossierId } = validateIpc(DossierIdInputSchema, args, 'dossier:deletePreview')
  return service.deletePreview(dossierId)
}

export function handleDossierDelete(service: Service, args: unknown): DeleteDossierResult {
  const { dossierId, fingerprint } = validateIpc(DossierDeleteSchema, args, 'dossier:delete')
  return service.deleteDossier(dossierId, fingerprint)
}

export function registerDossierHandlers(
  createService: () => Service = () => new DossierService(getDatabase(), { getActiveSessionId })
): void {
  ipcMain.handle('dossier:list', () => handleDossierList(createService()))
  ipcMain.handle('dossier:get', (_event, args: unknown) => handleDossierGet(createService(), args))
  ipcMain.handle('dossier:create', (_event, args: unknown) =>
    handleDossierCreate(createService(), args)
  )
  ipcMain.handle('dossier:update', (_event, args: unknown) =>
    handleDossierUpdate(createService(), args)
  )
  ipcMain.handle('dossier:deletePreview', (_event, args: unknown) =>
    handleDossierDeletePreview(createService(), args)
  )
  ipcMain.handle('dossier:delete', (_event, args: unknown) =>
    handleDossierDelete(createService(), args)
  )
}
