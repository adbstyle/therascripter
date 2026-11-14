import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  acquireDossierEditor,
  flushAllDossierDrafts,
  releaseDossierEditor,
  type DossierEditor,
  type DossierEditorState,
  type DossierField
} from '../stores/dossierDrafts'
import type { Dossier } from '../../../shared/types/Dossier'

export interface DossierAutosave {
  state: DossierEditorState
  change: (field: DossierField, value: string) => void
  commit: (field: DossierField) => void
  retry: () => void
}

const noopSubscribe = (): (() => void) => () => undefined

/**
 * Autosave der Stammdaten (#204 AK 10/11) über den Entwurfs-Editor in
 * `stores/dossierDrafts.ts`. Der Editor wird belegt, sobald das Dossier
 * geladen ist, und beim Verlassen der Seite freigegeben — ausstehende gültige
 * Änderungen werden dabei sofort gespeichert. Beim Schliessen des Fensters
 * ebenso. Gibt null zurück, solange das Dossier nicht geladen ist.
 */
export function useDossierAutosave(dossier: Dossier | null): DossierAutosave | null {
  const [editor, setEditor] = useState<DossierEditor | null>(null)
  const dossierRef = useRef(dossier)
  dossierRef.current = dossier
  const dossierId = dossier?.id ?? null

  useEffect(() => {
    const current = dossierRef.current
    if (!current || current.id !== dossierId) return
    const acquired = acquireDossierEditor(current)
    setEditor(acquired)
    return () => {
      releaseDossierEditor(acquired)
      setEditor(null)
    }
  }, [dossierId])

  useEffect(() => {
    const flush = (): void => void flushAllDossierDrafts()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  const state = useSyncExternalStore(
    editor?.subscribe ?? noopSubscribe,
    () => editor?.getState() ?? null
  )

  if (!editor || !state) return null
  return { state, change: editor.change, commit: editor.commit, retry: editor.retry }
}
