import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigation } from '../navigation/navigation'
import { useRecordingState } from './recording'
import { useToast } from '../hooks/useToast'
import { NewDossierDialog } from '../components/dossier/NewDossierDialog'
import type { Dossier } from '../../../shared/types/Dossier'
import {
  WorkspaceActionsContext,
  type ImportPdfOptions,
  type StartRecordingOptions,
  type WorkspaceActions
} from './workspaceActions'

/**
 * Aktionen, die mehrere Stellen der Shell auslösen (Seitenkopf, Seitenleiste,
 * Ziehen und Ablegen). Die Listen laden danach selbst über `sessions:changed`
 * nach — ein manueller Refresh ist nicht nötig.
 */
export function WorkspaceActionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { navigate } = useNavigation()
  const { isRecording, startRecording: start } = useRecordingState()
  const toast = useToast()
  const [isImporting, setIsImporting] = useState(false)
  const [newDossierOpen, setNewDossierOpen] = useState(false)
  const importingRef = useRef(false)
  // Ohne Dossier führt der Aufnahmestart zur Sitzungsliste, dort lebt die
  // Live-Karte. Mit Dossier (ab #206) bleibt die App auf dessen Seite.
  const navigateOnStart = useRef(true)

  const startRecording = useCallback(
    async (options: StartRecordingOptions = {}) => {
      navigateOnStart.current = options.dossierId === undefined
      await start()
    },
    [start]
  )

  const wasRecording = useRef(isRecording)
  useEffect(() => {
    if (isRecording && !wasRecording.current && navigateOnStart.current) {
      navigate({ kind: 'sessions' })
    }
    wasRecording.current = isRecording
  }, [isRecording, navigate])

  const importPdfs = useCallback(async (filePaths?: string[], _options?: ImportPdfOptions) => {
    if (importingRef.current) return
    importingRef.current = true
    try {
      const paths = filePaths ?? (await window.api.import.showPDFDialog())
      if (paths.length === 0) return
      setIsImporting(true)
      await window.api.import.pdf(paths)
    } finally {
      importingRef.current = false
      setIsImporting(false)
    }
  }, [])

  const openNewDossier = useCallback(() => setNewDossierOpen(true), [])
  const closeNewDossier = useCallback(() => setNewDossierOpen(false), [])
  const dossierCreated = useCallback(
    (dossier: Dossier) => {
      setNewDossierOpen(false)
      navigate({ kind: 'dossier', dossierId: dossier.id })
      toast.success('Patientendossier angelegt')
    },
    [navigate, toast]
  )

  const value = useMemo<WorkspaceActions>(
    () => ({ startRecording, importPdfs, isImporting, openNewDossier }),
    [startRecording, importPdfs, isImporting, openNewDossier]
  )

  return (
    <WorkspaceActionsContext.Provider value={value}>
      {children}
      {newDossierOpen && <NewDossierDialog onClose={closeNewDossier} onCreated={dossierCreated} />}
    </WorkspaceActionsContext.Provider>
  )
}
