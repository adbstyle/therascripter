import { ipcRenderer } from 'electron'
import type { DossierApi } from '../../shared/types/ipc/DossierApi'
import { DossiersChangedSchema } from '../../shared/validation/dossier-schemas'

/** Patientendossiers (#204, #205). Eingehende Events werden mit Zod geprüft. */
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
  onChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const parsed = DossiersChangedSchema.safeParse(raw)
      if (parsed.success) callback(parsed.data)
    }
    ipcRenderer.on('dossiers:changed', handler)
    return () => {
      ipcRenderer.removeListener('dossiers:changed', handler)
    }
  }
}
