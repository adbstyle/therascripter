import { createContext, useContext } from 'react'

export interface StartRecordingOptions {
  /** Ab #206: Aufnahme direkt einem Patientendossier zuordnen (noch ignoriert). */
  dossierId?: string
}

export interface ImportPdfOptions {
  /** Ab #206: importierte PDFs direkt einem Patientendossier zuordnen (noch ignoriert). */
  dossierId?: string
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
