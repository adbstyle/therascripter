import type {
  CreateDossierInput,
  CreateDossierResult,
  DeleteDossierResult,
  Dossier,
  DossierDeletePreview,
  DossierListItem,
  DossierAssignmentResult,
  DossierPatch,
  DossierRef,
  TimelineEntry,
  UpdateDossierResult
} from '../Dossier'

/** Payload des Events `dossiers:changed`. */
export interface DossiersChangedData {
  /** IDs gelöschter Dossiers (leer bei Anlage/Änderung). */
  deletedIds: string[]
}

/** Patientendossiers (#204) samt Zuordnung und Verlauf (#205). */
export interface DossierApi {
  list(): Promise<DossierListItem[]>
  get(dossierId: string): Promise<Dossier | null>
  create(input: CreateDossierInput): Promise<CreateDossierResult>
  update(dossierId: string, patch: DossierPatch): Promise<UpdateDossierResult>
  deletePreview(dossierId: string): Promise<DossierDeletePreview | null>
  delete(dossierId: string, fingerprint: string): Promise<DeleteDossierResult>
  /** #205 — Verlauf: jüngster Tag zuerst, mit `sortDay` und den Dossiers jedes Eintrags. */
  timeline(dossierId: string): Promise<TimelineEntry[]>
  /** #205 — Dossiers einer Sitzung, alphabetisch. */
  listForSession(sessionId: string): Promise<DossierRef[]>
  assign(sessionId: string, dossierId: string): Promise<DossierAssignmentResult>
  unassign(sessionId: string, dossierId: string): Promise<DossierAssignmentResult>
  onChanged(callback: (data: DossiersChangedData) => void): () => void
}
