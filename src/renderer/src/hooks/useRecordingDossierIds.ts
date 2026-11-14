import { useEffect } from 'react'
import { useLiveQuery } from './useLiveQuery'
import { useRecordingState } from '../contexts/recording'

interface Result {
  sessionId: string | null
  dossierIds: string[]
}

/**
 * Patientendossiers, denen die laufende Aufnahme gerade zugeordnet ist —
 * deren Verlauf zeigt die Live-Karte (#206). Die Shell blendet dort die
 * Aufnahme-Leiste aus, die Dossier-Seite zeigt den Consent-Hinweis.
 *
 * Folgt Zuordnungen auch während der Aufnahme (Plaketten, #205 AK 3) über
 * `sessions:changed`/`dossiers:changed`. Bis die erste Antwort zur neuen
 * Aufnahme da ist, gilt das Dossier, aus dem heraus sie gestartet wurde.
 * Ohne Aufnahme: leer, ohne Abfrage.
 */
export function useRecordingDossierIds(): string[] {
  const { isRecording, sessionId, recordingDossierId } = useRecordingState()
  const active = isRecording ? sessionId : null
  const query = useLiveQuery<Result>(
    async () => ({
      sessionId: active,
      dossierIds: active ? (await window.api.dossiers.listForSession(active)).map((d) => d.id) : []
    }),
    [
      (cb) => window.api.sessions.onChanged(() => cb()),
      (cb) => window.api.dossiers.onChanged(() => cb())
    ],
    { sessionId: null, dossierIds: [] }
  )
  const { refresh } = query
  useEffect(() => {
    void refresh()
  }, [active, refresh])

  if (!active) return []
  if (query.data.sessionId !== active) return recordingDossierId ? [recordingDossierId] : []
  return query.data.dossierIds
}
