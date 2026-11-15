import { createContext, useContext } from 'react'

export interface StartRecordingOptions {
  /** #206: Aufnahme ab Beginn diesem Patientendossier zuordnen; die App bleibt auf seiner Seite. */
  dossierId?: string
  /** «Nachname, Vorname» — für den Hinweis, falls die Zuordnung scheitert (AK 2). */
  dossierName?: string
}

export interface ImportPdfOptions {
  /** #206: jedes importierte PDF vor seiner Verarbeitung diesem Patientendossier zuordnen. */
  dossierId?: string
  /** «Nachname, Vorname» — für den Hinweis, falls die Zuordnung scheitert (AK 2). */
  dossierName?: string
}

export interface WorkspaceActions {
  /** Startet eine Aufnahme; ohne Dossier wechselt die App zur Sitzungsliste. */
  startRecording: (options?: StartRecordingOptions) => Promise<void>
  /** Importiert PDFs; ohne Pfade öffnet sich die Dateiauswahl. */
  importPdfs: (filePaths?: string[], options?: ImportPdfOptions) => Promise<void>
  /** Gemeinsam für Knopf, Seitenleiste und Ziehen und Ablegen. */
  isImporting: boolean
  /** Öffnet «Neues Patientendossier»; danach führt die App zum neuen Dossier (#204). */
  openNewDossier: () => void
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null)

/** Aufnahme starten und PDFs importieren — von überall in der Shell (Epic #192). */
export function useWorkspaceActions(): WorkspaceActions {
  const actions = useContext(WorkspaceActionsContext)
  if (!actions) throw new Error('useWorkspaceActions braucht einen WorkspaceActionsProvider')
  return actions
}
