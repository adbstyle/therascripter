import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigation } from '../navigation/navigation'
import { useRecordingState } from './recording'
import { useToast } from '../hooks/useToast'
import { NewDossierDialog } from '../components/dossier/NewDossierDialog'
import type { Dossier } from '../../../shared/types/Dossier'
import { dossierListName } from '../utils/dossierFormat'
import { pdfsNotAssignedNotice, recordingNotAssignedNotice } from '../utils/dossierAssignmentNotice'
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
  // Live-Karte. Mit Dossier (#206) bleibt die App auf dessen Seite, deren
  // Verlauf die Live-Karte zeigt.
  const navigateOnStart = useRef(true)

  /** Name für einen Hinweis: vom Aufrufer, sonst nachgeschlagen (null, wenn gelöscht). */
  const nameOf = useCallback(
    async (dossierId: string, known: string | undefined): Promise<string | null> => {
      if (known) return known
      try {
        const dossier = await window.api.dossiers.get(dossierId)
        return dossier ? dossierListName(dossier) : null
      } catch {
        return null
      }
    },
    []
  )

  const startRecording = useCallback(
    async (options: StartRecordingOptions = {}) => {
      const { dossierId, dossierName } = options
      navigateOnStart.current = dossierId === undefined
      const startedAt = new Date()
      const result = dossierId ? await start({ dossierId }) : await start()
      // #206 AK 2 — die Aufnahme läuft, aber ohne Zuordnung: sagen, welche
      if (dossierId && result?.assignment === 'failed') {
        toast.error(recordingNotAssignedNotice(startedAt, await nameOf(dossierId, dossierName)), {
          durationMs: 10_000
        })
      }
    },
    [start, toast, nameOf]
  )

  const wasRecording = useRef(isRecording)
  useEffect(() => {
    if (isRecording && !wasRecording.current && navigateOnStart.current) {
      navigate({ kind: 'sessions' })
    }
    wasRecording.current = isRecording
  }, [isRecording, navigate])

  const importPdfs = useCallback(
    async (filePaths?: string[], options: ImportPdfOptions = {}) => {
      if (importingRef.current) return
      importingRef.current = true
      const { dossierId, dossierName } = options
      try {
        const paths = filePaths ?? (await window.api.import.showPDFDialog())
        if (paths.length === 0) return
        setIsImporting(true)
        const result = dossierId
          ? await window.api.import.pdf(paths, { dossierId })
          : await window.api.import.pdf(paths)
        // #206 AK 2 — importiert, aber nicht zugeordnet: jedes PDF beim Titel nennen
        if (dossierId && result.unassigned.length > 0) {
          toast.error(
            pdfsNotAssignedNotice(
              result.unassigned.map((u) => u.title),
              await nameOf(dossierId, dossierName)
            ),
            { durationMs: 10_000 }
          )
        }
      } finally {
        importingRef.current = false
        setIsImporting(false)
      }
    },
    [toast, nameOf]
  )

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
