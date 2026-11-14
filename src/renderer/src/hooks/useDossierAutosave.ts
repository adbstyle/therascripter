import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  acquireDossierEditor,
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
 * Änderungen werden dabei sofort gespeichert. Beim Beenden der App speichert
 * der Entwurfsspeicher über `services/pendingEdits.ts` (Anfrage des
 * Main-Prozesses vor dem Schliessen der Datenbank). Das Schliessen des
 * Fensters versteckt es nur; die Seite bleibt gemountet. Gibt null zurück,
 * solange das Dossier nicht geladen ist.
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

  const state = useSyncExternalStore(
    editor?.subscribe ?? noopSubscribe,
    () => editor?.getState() ?? null
  )

  if (!editor || !state) return null
  return { state, change: editor.change, commit: editor.commit, retry: editor.retry }
}
