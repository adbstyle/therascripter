import type {
  CreateDossierInput,
  CreateDossierResult,
  DeleteDossierResult,
  Dossier,
  DossierDeletePreview,
  DossierListItem,
  DossierPatch,
  UpdateDossierResult
} from '../Dossier'

/** Payload des Events `dossiers:changed`. */
export interface DossiersChangedData {
  /** IDs gelöschter Dossiers (leer bei Anlage/Änderung). */
  deletedIds: string[]
}

/**
 * Patientendossiers (#204). #205 ergänzt timeline, listForSession, assign und
 * unassign in eigenen Zeilen.
 */
export interface DossierApi {
  list(): Promise<DossierListItem[]>
  get(dossierId: string): Promise<Dossier | null>
  create(input: CreateDossierInput): Promise<CreateDossierResult>
  update(dossierId: string, patch: DossierPatch): Promise<UpdateDossierResult>
  deletePreview(dossierId: string): Promise<DossierDeletePreview | null>
  delete(dossierId: string, fingerprint: string): Promise<DeleteDossierResult>
  onChanged(callback: (data: DossiersChangedData) => void): () => void
}
