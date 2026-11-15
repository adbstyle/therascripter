import { ipcRenderer } from 'electron'
import type { DossierApi } from '../../shared/types/ipc/DossierApi'
import { DossiersChangedSchema } from '../../shared/validation/dossier-schemas'
import { SKIP, subscribeChannel } from './channelHub'

/** Patientendossiers (#204, #205). Eingehende Events werden mit Zod geprüft, einmal pro Ereignis (channelHub). */
export const dossierApi: DossierApi = {
  list: () => ipcRenderer.invoke('dossier:list'),
  get: (dossierId) => ipcRenderer.invoke('dossier:get', { dossierId }),
  create: (input) => ipcRenderer.invoke('dossier:create', input),
  update: (dossierId, patch) => ipcRenderer.invoke('dossier:update', { dossierId, patch }),
  deletePreview: (dossierId) => ipcRenderer.invoke('dossier:deletePreview', { dossierId }),
  delete: (dossierId, fingerprint) =>
    ipcRenderer.invoke('dossier:delete', { dossierId, fingerprint }),
  timeline: (dossierId) => ipcRenderer.invoke('dossier:timeline', { dossierId }),
  listForSession: (sessionId) => ipcRenderer.invoke('dossier:listForSession', { sessionId }),
  assign: (sessionId, dossierId) => ipcRenderer.invoke('dossier:assign', { sessionId, dossierId }),
  unassign: (sessionId, dossierId) =>
    ipcRenderer.invoke('dossier:unassign', { sessionId, dossierId }),
  onChanged: (callback) =>
    subscribeChannel(
      'dossiers:changed',
      (raw) => {
        const parsed = DossiersChangedSchema.safeParse(raw)
        return parsed.success ? parsed.data : SKIP
      },
      callback
    )
}
