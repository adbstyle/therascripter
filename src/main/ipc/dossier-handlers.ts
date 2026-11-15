import { ipcMain } from 'electron'
import { getDatabase } from '../db/connection'
import { DossierService } from '../services/DossierService'
import { SessionDossierService } from '../services/SessionDossierService'
import { getActiveSessionId } from './recording-handlers'
import { validateIpc } from '../utils/ipc-helpers'
import {
  DossierCreateSchema,
  DossierAssignmentSchema,
  DossierDeleteSchema,
  DossierIdInputSchema,
  DossierUpdateSchema,
  SessionIdInputSchema
} from '../../shared/validation/dossier-schemas'
import type {
  CreateDossierResult,
  DeleteDossierResult,
  Dossier,
  DossierDeletePreview,
  DossierAssignmentResult,
  DossierListItem,
  DossierRef,
  TimelineEntry,
  UpdateDossierResult
} from '../../shared/types/Dossier'

// IPC für Patientendossiers (#204) und ihre Zuordnungen (#205).

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

type AssignmentService = Pick<
  SessionDossierService,
  'timeline' | 'listForSession' | 'assign' | 'unassign'
>

export function handleDossierTimeline(service: AssignmentService, args: unknown): TimelineEntry[] {
  const { dossierId } = validateIpc(DossierIdInputSchema, args, 'dossier:timeline')
  return service.timeline(dossierId)
}

export function handleDossierListForSession(
  service: AssignmentService,
  args: unknown
): DossierRef[] {
  const { sessionId } = validateIpc(SessionIdInputSchema, args, 'dossier:listForSession')
  return service.listForSession(sessionId)
}

export function handleDossierAssign(
  service: AssignmentService,
  args: unknown
): DossierAssignmentResult {
  const { sessionId, dossierId } = validateIpc(DossierAssignmentSchema, args, 'dossier:assign')
  return service.assign(sessionId, dossierId)
}

export function handleDossierUnassign(
  service: AssignmentService,
  args: unknown
): DossierAssignmentResult {
  const { sessionId, dossierId } = validateIpc(DossierAssignmentSchema, args, 'dossier:unassign')
  return service.unassign(sessionId, dossierId)
}

/** #205 — Zuordnen, Lösen und Verlauf. */
export function registerDossierAssignmentHandlers(
  createService: () => AssignmentService = () => new SessionDossierService(getDatabase())
): void {
  ipcMain.handle('dossier:timeline', (_event, args: unknown) =>
    handleDossierTimeline(createService(), args)
  )
  ipcMain.handle('dossier:listForSession', (_event, args: unknown) =>
    handleDossierListForSession(createService(), args)
  )
  ipcMain.handle('dossier:assign', (_event, args: unknown) =>
    handleDossierAssign(createService(), args)
  )
  ipcMain.handle('dossier:unassign', (_event, args: unknown) =>
    handleDossierUnassign(createService(), args)
  )
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
